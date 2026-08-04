import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Keychain from 'react-native-keychain';
import type {
  LoginResponse,
  MeTicketDetailView,
  MeTicketsView,
  SessionView,
  TroubleshootSubmitRequest,
  VerificationView,
} from '@fsm/shared';
import {
  apiGetMyTickets,
  apiGetTicketDetail,
  apiGetTicketVerification,
  apiLogin,
  apiMe,
  apiRefresh,
  apiSetSoftState,
  apiSubmitTroubleshoot,
  SoftStateConflictError,
  TroubleshootConflictError,
} from './client';

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: () => 'device-uuid-fixed-for-tests',
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

const keychain = jest.mocked(Keychain);

// The mock is typed by lib.dom's fetch; the global.fetch slot is typed by React Native's fetch
// (no URL in RequestInfo). They are assignment-incompatible, so cast on assignment only — the
// mock keeps its own typing for `.mock.calls` assertions.
function installFetchMock() {
  const fetchMock = jest.fn<typeof fetch>();
  global.fetch = fetchMock as unknown as typeof global.fetch;
  return fetchMock;
}

describe('apiLogin', () => {
  const tokens: LoginResponse = { accessToken: 'header.payload.sig', refreshToken: 'refresh.token.value' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the credentials to /auth/login and returns the token pair', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => tokens } as unknown as Response);

    const result = await apiLogin({ email: 'zm.north@fsm.test', password: 'correct-password' });

    expect(result).toEqual(tokens);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/auth\/login$/);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'zm.north@fsm.test', password: 'correct-password' }),
    });
  });

  it('#54 non-retrofittable: sends X-Device-Id and X-App-Version on login', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => tokens } as unknown as Response);

    await apiLogin({ email: 'zm.north@fsm.test', password: 'correct-password' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({
      headers: { 'X-Device-Id': 'device-uuid-fixed-for-tests', 'X-App-Version': '9.9.9' },
    });
  });

  it('throws INVALID_CREDENTIALS when the server rejects the login', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);

    await expect(apiLogin({ email: 'x@y.z', password: 'wrong' })).rejects.toThrow('INVALID_CREDENTIALS');
  });
});

describe('apiMe', () => {
  const session: SessionView = { user_id: 'u-1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /me with a Bearer token and returns the session view', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => session } as unknown as Response);

    const result = await apiMe('header.payload.sig');

    expect(result).toEqual(session);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me$/);
    expect(init).toMatchObject({
      headers: { Authorization: 'Bearer header.payload.sig', 'X-Device-Id': 'device-uuid-fixed-for-tests' },
    });
  });

  it('throws UNAUTHORIZED when the token is rejected', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);

    await expect(apiMe('bad-token')).rejects.toThrow('UNAUTHORIZED');
  });
});

describe('apiRefresh', () => {
  const tokens: LoginResponse = { accessToken: 'new.access.sig', refreshToken: 'new.refresh.value' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the refresh token to /auth/refresh and returns the rotated pair', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => tokens } as unknown as Response);

    const result = await apiRefresh('old.refresh.value');

    expect(result).toEqual(tokens);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/auth\/refresh$/);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'old.refresh.value' }),
    });
  });

  it('#54 non-retrofittable: sends X-Device-Id and X-App-Version on refresh', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => tokens } as unknown as Response);

    await apiRefresh('old.refresh.value');

    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({
      headers: { 'X-Device-Id': 'device-uuid-fixed-for-tests', 'X-App-Version': '9.9.9' },
    });
  });

  it('throws UNAUTHORIZED when the refresh token is rejected', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);

    await expect(apiRefresh('revoked.refresh.value')).rejects.toThrow('UNAUTHORIZED');
  });
});

describe('apiGetMyTickets', () => {
  const view: MeTicketsView = { items: [], cursor: null };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /me/tickets with a Bearer token and the standard headers', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetMyTickets('header.payload.sig');

    expect(result).toEqual(view);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me\/tickets$/);
    expect(init).toMatchObject({
      headers: {
        Authorization: 'Bearer header.payload.sig',
        'X-Device-Id': 'device-uuid-fixed-for-tests',
        'X-App-Version': '9.9.9',
      },
    });
  });

  it('throws UNAUTHORIZED when the token is rejected', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);

    await expect(apiGetMyTickets('bad-token')).rejects.toThrow('UNAUTHORIZED');
  });
});

describe('apiGetTicketDetail', () => {
  const detail = { ticketId: 't-1', ticketNoDisplay: 'TCK-00306' } as MeTicketDetailView;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /me/tickets/:id with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => detail } as unknown as Response);

    const result = await apiGetTicketDetail('header.payload.sig', 't-1');

    expect(result).toEqual(detail);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me\/tickets\/t-1$/);
    expect(init).toMatchObject({ headers: { Authorization: 'Bearer header.payload.sig' } });
  });

  it('throws TICKET_NOT_FOUND on a 404', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

    await expect(apiGetTicketDetail('token', 't-1')).rejects.toThrow('TICKET_NOT_FOUND');
  });
});

describe('apiGetTicketVerification', () => {
  const view = { ticketId: 't-1', phase: 'PENDING' } as VerificationView;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /tickets/:id/verification with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetTicketVerification('header.payload.sig', 't-1');

    expect(result).toEqual(view);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/tickets\/t-1\/verification$/);
  });

  it('throws NO_VERIFICATION_RUN on a 404', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

    await expect(apiGetTicketVerification('token', 't-1')).rejects.toThrow('NO_VERIFICATION_RUN');
  });
});

describe('apiSetSoftState', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the target (and location, when given) to /tickets/:id/soft-state', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const response = { result: 'OK', softState: { softStateId: '1', type: 'ON_SITE' } };
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);

    const result = await apiSetSoftState('header.payload.sig', 't-1', {
      target: 'ON_SITE',
      location: { lat: 12.9, lng: 77.6 },
    });

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/tickets\/t-1\/soft-state$/);
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ target: 'ON_SITE', location: { lat: 12.9, lng: 77.6 } }),
    });
  });

  it('omits location entirely when not captured (Mark ON_SITE fallback) — never sends location:null', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'OK', softState: {} }),
    } as unknown as Response);

    await apiSetSoftState('token', 't-1', { target: 'ON_SITE' });

    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect('location' in sentBody).toBe(false);
  });

  it('throws SoftStateConflictError carrying from/to on a 409', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'INVALID_SOFT_STATE_TRANSITION', from: 'VIEWED', to: 'TROUBLESHOOT_STARTED' }),
    } as unknown as Response);

    const promise = apiSetSoftState('token', 't-1', { target: 'TROUBLESHOOT_STARTED' });

    await expect(promise).rejects.toBeInstanceOf(SoftStateConflictError);
    await expect(promise.catch((e: SoftStateConflictError) => e)).resolves.toMatchObject({
      from: 'VIEWED',
      to: 'TROUBLESHOOT_STARTED',
    });
  });
});

describe('apiSubmitTroubleshoot', () => {
  const request: TroubleshootSubmitRequest = {
    clientSubmissionId: 'sub-1',
    rootCauseCategory: 'POWER_ISSUE',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the submission to /tickets/:id/troubleshoot', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const response = { result: 'OK', duplicate: false, submission: {} };
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);

    const result = await apiSubmitTroubleshoot('token', 't-1', request);

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/tickets\/t-1\/troubleshoot$/);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(request) });
  });

  it('throws the server 400 code verbatim (defensive — client validation should prevent both)', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'ROOT_CAUSE_CATEGORY_REQUIRED' }),
    } as unknown as Response);

    await expect(apiSubmitTroubleshoot('token', 't-1', request)).rejects.toThrow('ROOT_CAUSE_CATEGORY_REQUIRED');
  });

  it('throws TroubleshootConflictError carrying the full payload on a 409', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        code: 'TICKET_ALREADY_CLOSED',
        status: 'CLOSED',
        winnerSeId: 'se-2',
        winnerAt: '2026-05-11T16:00:00Z',
        shadowUseRecorded: true,
      }),
    } as unknown as Response);

    const promise = apiSubmitTroubleshoot('token', 't-1', request);

    await expect(promise).rejects.toBeInstanceOf(TroubleshootConflictError);
    await expect(promise.catch((e: TroubleshootConflictError) => e)).resolves.toMatchObject({
      winnerSeId: 'se-2',
      shadowUseRecorded: true,
    });
  });
});
