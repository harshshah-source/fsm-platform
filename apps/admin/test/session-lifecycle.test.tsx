import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginError, apiLogin } from '../src/api/client';
import { makeAuthFetch, setOnSessionExpired } from '../src/api/http';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '../src/api/tokens';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { ProtectedRoute } from '../src/auth/ProtectedRoute';
import { LoginPage } from '../src/pages/LoginPage';

/**
 * Issue 109 — admin session lifecycle. Covers the central 401 policy (expiry → refresh → retry, rotation
 * reuse-rejection → logout), mount rehydration via /me, and honest login-error mapping.
 */
const BASE = 'http://localhost:3000/api';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ZM: SessionView = { user_id: 'u1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  setOnSessionExpired(() => {});
});

describe('central 401 policy (makeAuthFetch)', () => {
  it('refreshes on 401 and retries the original request once with the new token', async () => {
    setTokens('old-access', 'old-refresh');
    const onExpired = vi.fn();
    setOnSessionExpired(onExpired);

    const raw = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return json({ accessToken: 'new-access', refreshToken: 'new-refresh' });
      // The data endpoint only succeeds once the refreshed bearer is presented.
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === 'Bearer new-access' ? json({ ok: true }) : json({}, 401);
    });

    const authFetch = makeAuthFetch(raw as typeof fetch);
    const res = await authFetch(`${BASE}/engineers/directory`, { headers: { Authorization: 'Bearer old-access' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getAccessToken()).toBe('new-access'); // rotation stored
    expect(getRefreshToken()).toBe('new-refresh');
    expect(onExpired).not.toHaveBeenCalled();
    // exactly: data(401) → refresh → data-retry
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it('rejects a reused/expired refresh token → clears session and fires the expiry hook', async () => {
    setTokens('old-access', 'consumed-refresh');
    const onExpired = vi.fn();
    setOnSessionExpired(onExpired);

    const raw = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return json({ message: 'refresh token reuse' }, 401);
      return json({}, 401);
    });

    const authFetch = makeAuthFetch(raw as typeof fetch);
    const res = await authFetch(`${BASE}/engineers/directory`, { headers: { Authorization: 'Bearer old-access' } });

    expect(res.status).toBe(401);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('does not attempt a refresh when the failing request IS the auth endpoint', async () => {
    setTokens('a', 'r');
    const onExpired = vi.fn();
    setOnSessionExpired(onExpired);
    const raw = vi.fn(async () => json({}, 401));
    const authFetch = makeAuthFetch(raw as typeof fetch);

    const res = await authFetch(`${BASE}/auth/login`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(raw).toHaveBeenCalledTimes(1); // no refresh recursion
    expect(onExpired).not.toHaveBeenCalled();
  });
});

describe('apiLogin error mapping', () => {
  it('maps 401 → INVALID_CREDENTIALS', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Unauthorized' }, 401)));
    await expect(apiLogin({ email: 'a@b.c', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('maps a 5xx → SERVICE_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));
    await expect(apiLogin({ email: 'a@b.c', password: 'x' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('maps a network failure → SERVICE_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await apiLogin({ email: 'a@b.c', password: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
  });
});

function RoleMarker() {
  const { session } = useAuth();
  return <div>SHELL role={session?.role ?? 'none'}</div>;
}

function renderGate() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<ProtectedRoute><RoleMarker /></ProtectedRoute>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('session restore on reload', () => {
  it('rehydrates the session via /me when a valid token is stored (no login bounce)', async () => {
    setTokens('valid-access', 'valid-refresh');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/me')) return json(ZM);
      return json({}, 404);
    }));

    renderGate();
    expect(await screen.findByText(/SHELL role=ZONAL_MANAGER/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /welcome back/i })).toBeNull();
  });

  it('lands on login cleanly when there is no stored token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)));
    renderGate();
    expect(await screen.findByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
  });
});

describe('expiry → login with a session-expired notice', () => {
  it('shows the notice on the login page after the session cannot be refreshed', async () => {
    setTokens('old-access', 'dead-refresh');
    render(
      <AuthProvider initialSession={ZM}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<ProtectedRoute><RoleMarker /></ProtectedRoute>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    // Authed shell is showing.
    expect(await screen.findByText(/SHELL role=ZONAL_MANAGER/)).toBeInTheDocument();

    // A data call 401s and the refresh is dead → the interceptor fires the AuthProvider-registered hook.
    const raw = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return json({}, 401);
      return json({}, 401);
    });
    const authFetch = makeAuthFetch(raw as typeof fetch);
    await authFetch(`${BASE}/engineers/directory`, { headers: { Authorization: 'Bearer old-access' } });

    expect(await screen.findByText(/your session expired/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
  });
});
