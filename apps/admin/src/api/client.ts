import type { LoginRequest, LoginResponse, SessionView } from '@fsm/shared';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type LoginErrorCode = 'INVALID_CREDENTIALS' | 'SERVICE_UNAVAILABLE';

/** Distinguishes a rejected credential (401) from the backend being unreachable/erroring (network/5xx). */
export class LoginError extends Error {
  code: LoginErrorCode;
  constructor(code: LoginErrorCode) {
    super(code);
    this.name = 'LoginError';
    this.code = code;
  }
}

export async function apiLogin(body: LoginRequest): Promise<LoginResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Network refusal / CORS / DNS — the backend is unreachable, NOT a wrong password.
    throw new LoginError('SERVICE_UNAVAILABLE');
  }
  if (res.status === 401) throw new LoginError('INVALID_CREDENTIALS');
  if (!res.ok) throw new LoginError('SERVICE_UNAVAILABLE'); // 5xx and anything else non-OK
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
