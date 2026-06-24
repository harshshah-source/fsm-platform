import type { LoginRequest, LoginResponse, SessionView } from '@fsm/shared';

// Expo inlines EXPO_PUBLIC_* at build time. Default targets the host machine's backend from
// the Android emulator, where 10.0.2.2 is the loopback alias for the host's localhost.
const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000/api';
console.log('[API] BASE_URL =', BASE_URL);

export async function apiLogin(body: LoginRequest): Promise<LoginResponse> {
  console.log('[API] apiLogin called');
  console.log('[API] POST', `${BASE_URL}/auth/login`);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.log('[API] fetch error', error);
    throw error;
  }
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
