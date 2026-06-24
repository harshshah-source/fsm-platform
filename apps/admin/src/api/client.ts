import type { LoginRequest, LoginResponse, SessionView } from '@fsm/shared';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export async function apiLogin(body: LoginRequest): Promise<LoginResponse> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('INVALID_CREDENTIALS');
  }
  return (await res.json()) as LoginResponse;
}

export async function apiMe(accessToken: string): Promise<SessionView> {
  const res = await fetch(`${BASE_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as SessionView;
}
