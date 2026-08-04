import Constants from 'expo-constants';
import type { LoginRequest, LoginResponse, MeTicketsView, SessionView } from '@fsm/shared';
import { getDeviceId } from '../device/deviceId';

// Expo inlines EXPO_PUBLIC_* at build time. Default targets the host machine's backend from
// the Android emulator, where 10.0.2.2 is the loopback alias for the host's localhost.
// #169 Wave 0 serves both /api and /api/v1 — v1 is the path this client pins to (#54 AC).
const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000/api/v1';

const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

// #54 non-retrofittable: X-Device-Id (D-2 one-active-device, #91) and X-App-Version (D-10, no OTA
// for the pilot) go on every request, including login/refresh — login especially, since that is
// where the server decides which prior device session to revoke. There is no channel to add a
// missing header to an already-installed client.
async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const deviceId = await getDeviceId();
  return {
    'X-Device-Id': deviceId,
    'X-App-Version': APP_VERSION,
    ...extra,
  };
}

export async function apiLogin(body: LoginRequest): Promise<LoginResponse> {
  const headers = await buildHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('INVALID_CREDENTIALS');
  }
  return (await res.json()) as LoginResponse;
}

export async function apiRefresh(refreshToken: string): Promise<LoginResponse> {
  const headers = await buildHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as LoginResponse;
}

export async function apiMe(accessToken: string): Promise<SessionView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/me`, { headers });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as SessionView;
}

export async function apiGetMyTickets(accessToken: string): Promise<MeTicketsView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/me/tickets`, { headers });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as MeTicketsView;
}
