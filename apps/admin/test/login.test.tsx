import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/AppRoutes';
import { AuthProvider } from '../src/auth/AuthProvider';

function stubApi(handlers: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = Object.keys(handlers).find((k) => url.endsWith(k));
      if (!key) return new Response('not found', { status: 404 });
      const { status = 200, body } = handlers[key];
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Admin shell — login flow', () => {
  it('logs in and renders the shell with the user role and zone', async () => {
    stubApi({
      '/auth/login': { body: { accessToken: 'access-1', refreshToken: 'refresh-1' } },
      '/me': { body: { user_id: 'u1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null } },
    });

    renderAt('/login');
    await userEvent.type(screen.getByLabelText(/email/i), 'zm.north@fsm.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/zonal manager/i)).toBeInTheDocument();
    expect(screen.getByText(/Zone 1/)).toBeInTheDocument();
    expect(sessionStorage.getItem('fsm.accessToken')).toBe('access-1');
  });

  it('shows an error and stays on the login page when credentials are rejected', async () => {
    stubApi({ '/auth/login': { status: 401, body: { message: 'Unauthorized' } } });

    renderAt('/login');
    await userEvent.type(screen.getByLabelText(/email/i), 'zm.north@fsm.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid email or password/i);
    expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
    expect(sessionStorage.getItem('fsm.accessToken')).toBeNull();
  });

  it('logs out, clears the token, and returns to the login page', async () => {
    stubApi({
      '/auth/login': { body: { accessToken: 'access-1', refreshToken: 'refresh-1' } },
      '/me': { body: { user_id: 'u1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null } },
    });

    renderAt('/login');
    await userEvent.type(screen.getByLabelText(/email/i), 'zm.north@fsm.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByText(/zonal manager/i);

    await userEvent.click(screen.getByRole('button', { name: /log out/i }));

    expect(await screen.findByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
    expect(sessionStorage.getItem('fsm.accessToken')).toBeNull();
  });
});
