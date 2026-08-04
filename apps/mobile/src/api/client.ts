import Constants from 'expo-constants';
import type {
  LoginRequest,
  LoginResponse,
  MeTicketDetailView,
  MeTicketsView,
  SessionView,
  SetSoftStateRequest,
  SetSoftStateResponse,
  SoftStateConflictBody,
  VerificationView,
} from '@fsm/shared';
import { getDeviceId } from '../device/deviceId';

export class SoftStateConflictError extends Error {
  readonly from: SoftStateConflictBody['from'];
  readonly to: SoftStateConflictBody['to'];

  constructor(body: SoftStateConflictBody) {
    super('INVALID_SOFT_STATE_TRANSITION');
    this.name = 'SoftStateConflictError';
    this.from = body.from;
    this.to = body.to;
  }
}

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

export async function apiGetTicketDetail(accessToken: string, ticketId: string): Promise<MeTicketDetailView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/me/tickets/${ticketId}`, { headers });
  if (res.status === 404) {
    throw new Error('TICKET_NOT_FOUND');
  }
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as MeTicketDetailView;
}

/** #57: only meaningful once the ticket is `VERIFICATION_PENDING` — a ready-state ticket 404s here
 *  by design (`NO_VERIFICATION_RUN`), so callers should check status before fetching. */
export async function apiGetTicketVerification(accessToken: string, ticketId: string): Promise<VerificationView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/tickets/${ticketId}/verification`, { headers });
  if (res.status === 404) {
    throw new Error('NO_VERIFICATION_RUN');
  }
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as VerificationView;
}

export async function apiSetSoftState(
  accessToken: string,
  ticketId: string,
  body: SetSoftStateRequest,
): Promise<SetSoftStateResponse> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' });
  const res = await fetch(`${BASE_URL}/tickets/${ticketId}/soft-state`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    throw new SoftStateConflictError((await res.json()) as SoftStateConflictBody);
  }
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as SetSoftStateResponse;
}
