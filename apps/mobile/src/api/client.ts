import Constants from 'expo-constants';
import type {
  ConfirmReceiptConflictBody,
  ConfirmReceiptResponse,
  CreateVoucherRequest,
  CreateVoucherResponse,
  DayPlanView,
  LoginRequest,
  LoginResponse,
  MediaKind,
  MediaSlot,
  MeComponentRequestsView,
  MeTicketDetailView,
  MeTicketsView,
  MeVouchersView,
  SessionView,
  SetSoftStateRequest,
  SetSoftStateResponse,
  SoftStateConflictBody,
  TroubleshootConflictBody,
  TroubleshootSubmitRequest,
  TroubleshootSubmitResponse,
  UploadMediaResponse,
  VanStockView,
  VerificationView,
} from '@fsm/shared';
import { getDeviceId } from '../device/deviceId';

export class ConfirmReceiptConflictError extends Error {
  readonly status: ConfirmReceiptConflictBody['status'];

  constructor(body: ConfirmReceiptConflictBody) {
    super('COMPONENT_REQUEST_INVALID_STATE');
    this.name = 'ConfirmReceiptConflictError';
    this.status = body.status;
  }
}

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

/** Business 409 (CONTEXT §Business 409 Conflict) — never thrown for an idempotency duplicate,
 *  which is a 200. #63 (the full-screen result) isn't built; carries the raw payload so a caller
 *  can render whatever it honestly can. */
export class TroubleshootConflictError extends Error {
  readonly status: string;
  readonly winnerSeId: string | null;
  readonly winnerAt: string | null;
  readonly shadowUseRecorded: boolean;

  constructor(body: TroubleshootConflictBody) {
    super('TICKET_ALREADY_CLOSED');
    this.name = 'TroubleshootConflictError';
    this.status = body.status;
    this.winnerSeId = body.winnerSeId;
    this.winnerAt = body.winnerAt;
    this.shadowUseRecorded = body.shadowUseRecorded;
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

export async function apiSubmitTroubleshoot(
  accessToken: string,
  ticketId: string,
  body: TroubleshootSubmitRequest,
): Promise<TroubleshootSubmitResponse> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' });
  const res = await fetch(`${BASE_URL}/tickets/${ticketId}/troubleshoot`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    throw new TroubleshootConflictError((await res.json()) as TroubleshootConflictBody);
  }
  if (res.status === 400) {
    const { code } = (await res.json()) as { code: string };
    throw new Error(code);
  }
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as TroubleshootSubmitResponse;
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

export async function apiGetVanStock(accessToken: string): Promise<VanStockView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/me/van-stock`, { headers });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as VanStockView;
}

export async function apiGetMyComponentRequests(accessToken: string): Promise<MeComponentRequestsView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/me/component-requests`, { headers });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as MeComponentRequestsView;
}

export async function apiConfirmReceipt(accessToken: string, requestId: string): Promise<ConfirmReceiptResponse> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/component-requests/${requestId}/confirm-receipt`, {
    method: 'POST',
    headers,
  });
  if (res.status === 404) {
    throw new Error('COMPONENT_REQUEST_NOT_FOUND');
  }
  if (res.status === 403) {
    throw new Error('COMPONENT_REQUEST_FORBIDDEN');
  }
  if (res.status === 409) {
    throw new ConfirmReceiptConflictError((await res.json()) as ConfirmReceiptConflictBody);
  }
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as ConfirmReceiptResponse;
}

export async function apiGetDayPlan(accessToken: string): Promise<DayPlanView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/schedules/me`, { headers });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as DayPlanView;
}

/** #81 — turns a captured photo into an opaque `photoRef`. No `Content-Type` header: fetch/RN sets
 *  the multipart boundary itself from the `FormData` body. */
export async function apiUploadMedia(
  accessToken: string,
  kind: MediaKind,
  slot: MediaSlot,
  file: { uri: string; name: string; type: string },
): Promise<UploadMediaResponse> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const form = new FormData();
  form.append('kind', kind);
  form.append('slot', slot);
  // RN's FormData accepts this {uri,name,type} shape for a file field; not expressible in the DOM
  // FormData typings, hence the cast.
  form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  const res = await fetch(`${BASE_URL}/media/upload`, { method: 'POST', headers, body: form });
  if (res.status === 400) {
    const { code } = (await res.json()) as { code: string };
    throw new Error(code);
  }
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as UploadMediaResponse;
}

export async function apiCreateVoucher(accessToken: string, body: CreateVoucherRequest): Promise<CreateVoucherResponse> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' });
  const res = await fetch(`${BASE_URL}/vouchers`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 400) {
    const { code } = (await res.json()) as { code: string };
    throw new Error(code);
  }
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as CreateVoucherResponse;
}

export async function apiGetMyVouchers(accessToken: string): Promise<MeVouchersView> {
  const headers = await buildHeaders({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${BASE_URL}/me/vouchers`, { headers });
  if (!res.ok) {
    throw new Error('UNAUTHORIZED');
  }
  return (await res.json()) as MeVouchersView;
}
