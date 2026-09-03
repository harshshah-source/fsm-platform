import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Keychain from 'react-native-keychain';
import type {
  CreateVoucherRequest,
  DayPlanView,
  LoginResponse,
  MeComponentRequestsView,
  MeTicketDetailView,
  MeTicketsView,
  MeVouchersView,
  SessionView,
  TroubleshootSubmitRequest,
  VanStockView,
  VerificationView,
} from '@fsm/shared';
import {
  apiConfirmReceipt,
  apiCreateVoucher,
  apiGetDayPlan,
  apiGetMyComponentRequests,
  apiGetMyAvailability,
  apiGetMyLeaveRequests,
  apiGetMyTickets,
  apiGetMyVouchers,
  apiGetNotifications,
  apiGetTicketDetail,
  apiGetTicketVerification,
  apiGetVanStock,
  apiInstallFitted,
  apiInstallOnSite,
  apiLogin,
  apiMarkAllNotificationsRead,
  apiMarkNotificationRead,
  apiMe,
  apiRecoveryMarkCollected,
  apiRecoveryOnSite,
  apiRecoveryUnableToCollect,
  apiRefresh,
  apiSetAvailability,
  apiSetSoftState,
  apiSubmitLeaveRequest,
  apiSubmitTroubleshoot,
  apiUploadMedia,
  ConfirmReceiptConflictError,
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
  const view: MeTicketsView = { items: [], cursor: null, total: 0 };

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
        winnerSeName: 'SE South',
        winnerAt: '2026-05-11T16:00:00Z',
        shadowUseRecorded: true,
      }),
    } as unknown as Response);

    const promise = apiSubmitTroubleshoot('token', 't-1', request);

    await expect(promise).rejects.toBeInstanceOf(TroubleshootConflictError);
    await expect(promise.catch((e: TroubleshootConflictError) => e)).resolves.toMatchObject({
      winnerSeId: 'se-2',
      winnerSeName: 'SE South',
      shadowUseRecorded: true,
    });
  });
});

describe('apiGetVanStock', () => {
  const view: VanStockView = { stock: [], commonKit: { complete: true, missing: [] } };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /me/van-stock with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetVanStock('token');

    expect(result).toEqual(view);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me\/van-stock$/);
  });
});

describe('apiGetMyComponentRequests', () => {
  const view: MeComponentRequestsView = { items: [], cursor: null };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /me/component-requests with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetMyComponentRequests('token');

    expect(result).toEqual(view);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me\/component-requests$/);
  });
});

describe('apiConfirmReceipt', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs to /component-requests/:id/confirm-receipt', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const response = { request: { requestId: 'r-1', status: 'RECEIVED' } };
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);

    const result = await apiConfirmReceipt('token', 'r-1');

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/component-requests\/r-1\/confirm-receipt$/);
    expect(init).toMatchObject({ method: 'POST' });
  });

  it('throws ConfirmReceiptConflictError carrying the real status on a 409', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'COMPONENT_REQUEST_INVALID_STATE', status: 'REQUESTED' }),
    } as unknown as Response);

    const promise = apiConfirmReceipt('token', 'r-1');

    await expect(promise).rejects.toBeInstanceOf(ConfirmReceiptConflictError);
    await expect(promise.catch((e: ConfirmReceiptConflictError) => e)).resolves.toMatchObject({ status: 'REQUESTED' });
  });

  it('throws COMPONENT_REQUEST_NOT_FOUND on a 404', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

    await expect(apiConfirmReceipt('token', 'r-1')).rejects.toThrow('COMPONENT_REQUEST_NOT_FOUND');
  });
});

describe('apiGetDayPlan', () => {
  const view: DayPlanView = { dispatched: false, scheduleId: null, dateFrom: null, dateTo: null, stops: [] };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /schedules/me with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetDayPlan('token');

    expect(result).toEqual(view);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/schedules\/me$/);
  });

  it('throws UNAUTHORIZED when the token is rejected', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);

    await expect(apiGetDayPlan('bad-token')).rejects.toThrow('UNAUTHORIZED');
  });
});

describe('apiUploadMedia', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs a multipart form to /media/upload and returns the photoRef', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const response = { photoRef: 'media-1', kind: 'VOUCHER', slot: 'RECEIPT' };
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => response } as unknown as Response);

    const result = await apiUploadMedia('token', 'VOUCHER', 'RECEIPT', {
      uri: 'file:///photo.jpg',
      name: 'photo.jpg',
      type: 'image/jpeg',
    });

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/media\/upload$/);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('throws the server 400 code verbatim', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'FILE_TOO_LARGE' }),
    } as unknown as Response);

    await expect(
      apiUploadMedia('token', 'VOUCHER', 'RECEIPT', { uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }),
    ).rejects.toThrow('FILE_TOO_LARGE');
  });
});

describe('apiCreateVoucher', () => {
  const request: CreateVoucherRequest = {
    clientSubmissionId: 'sub-1',
    items: [{ category: 'TRAVEL', amount: 100, photoRef: 'media-1' }],
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the voucher to /vouchers', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const response = {
      voucher: { voucherId: 'v-1', seId: 'se-1', clientSubmissionId: 'sub-1', status: 'ZONAL_MANAGER_REVIEW', totalAmount: 100, submittedAt: null },
      duplicate: false,
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);

    const result = await apiCreateVoucher('token', request);

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/vouchers$/);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(request) });
  });

  it('throws the server 400 code verbatim (e.g. PHOTO_REQUIRED)', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'PHOTO_REQUIRED' }),
    } as unknown as Response);

    await expect(apiCreateVoucher('token', request)).rejects.toThrow('PHOTO_REQUIRED');
  });
});

describe('apiGetMyVouchers', () => {
  const view: MeVouchersView = { items: [], cursor: null, summary: { claimedTotal: 0, pendingCount: 0, approvedCount: 0 } };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /me/vouchers with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetMyVouchers('token');

    expect(result).toEqual(view);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me\/vouchers$/);
  });
});

describe('#68 — recovery action endpoints', () => {
  const response = {
    ticketId: 't-1',
    status: 'ON_SITE',
    deviceId: '9800001',
    assignedSeId: 'se-1',
    collectedDeviceSerial: null,
    collectionConditionNotes: null,
    unableToCollectReason: null,
    closureType: null,
    closedAt: null,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('apiRecoveryOnSite POSTs to /recovery/:id/on-site with no body fields', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);

    const result = await apiRecoveryOnSite('token', 't-1');

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/recovery\/t-1\/on-site$/);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({}) });
  });

  it('apiRecoveryMarkCollected POSTs the serial and condition notes to /recovery/:id/collected', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...response, status: 'COLLECTED' }),
    } as unknown as Response);

    await apiRecoveryMarkCollected('token', 't-1', { deviceSerial: '9800001', conditionNotes: 'minor scratches' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/recovery\/t-1\/collected$/);
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ deviceSerial: '9800001', conditionNotes: 'minor scratches' }),
    });
  });

  it('apiRecoveryMarkCollected throws INVALID_DEVICE_SERIAL verbatim on a serial mismatch', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'INVALID_DEVICE_SERIAL' }),
    } as unknown as Response);

    await expect(
      apiRecoveryMarkCollected('token', 't-1', { deviceSerial: 'wrong', conditionNotes: 'ok' }),
    ).rejects.toThrow('INVALID_DEVICE_SERIAL');
  });

  it('apiRecoveryUnableToCollect POSTs the reason code to /recovery/:id/unable-to-collect', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...response, status: 'ON_SITE', unableToCollectReason: 'DEVICE_MISSING' }),
    } as unknown as Response);

    await apiRecoveryUnableToCollect('token', 't-1', { reasonCode: 'DEVICE_MISSING' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/recovery\/t-1\/unable-to-collect$/);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ reasonCode: 'DEVICE_MISSING' }) });
  });
});

describe('#71 — install action endpoints', () => {
  const response = {
    ticketId: 't-1',
    status: 'ON_SITE',
    deviceId: '9800001',
    assignedSeId: 'se-1',
    fittedGpsSerial: null,
    fittedSimSerial: null,
    fittedPhotoRef: null,
    fittedAt: null,
    activatedAt: null,
    closedAt: null,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('apiInstallOnSite POSTs to /install/:id/on-site with no body fields', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);

    const result = await apiInstallOnSite('token', 't-1');

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/install\/t-1\/on-site$/);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({}) });
  });

  it('apiInstallFitted POSTs the GPS serial, SIM serial, and optional photoRef to /install/:id/fitted', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...response, status: 'ACTIVATED' }),
    } as unknown as Response);

    await apiInstallFitted('token', 't-1', { gpsDeviceSerial: '9800001', simSerial: '8991000', photoRef: 'media-1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/install\/t-1\/fitted$/);
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ gpsDeviceSerial: '9800001', simSerial: '8991000', photoRef: 'media-1' }),
    });
  });

  it('apiInstallFitted throws INVALID_SERIAL verbatim on a GPS serial mismatch', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'INVALID_SERIAL' }),
    } as unknown as Response);

    await expect(
      apiInstallFitted('token', 't-1', { gpsDeviceSerial: 'wrong', simSerial: '8991000' }),
    ).rejects.toThrow('INVALID_SERIAL');
  });

  it('apiInstallFitted throws SERIAL_REQUIRED verbatim on a blank SIM serial', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'SERIAL_REQUIRED' }),
    } as unknown as Response);

    await expect(
      apiInstallFitted('token', 't-1', { gpsDeviceSerial: '9800001', simSerial: '' }),
    ).rejects.toThrow('SERIAL_REQUIRED');
  });
});

// #268 — the "#77 — intraday insertion endpoints" describe block (apiGetMyIntradayOffers,
// apiAcceptIntradayInsertion, apiDeclineIntradayInsertion) is retired with the backend routes it
// pinned: GET /me/intraday-insertions, POST /intraday-insertions/:id/accept and .../decline all now
// 404 (#169). SE Acceptance no longer exists on the CRITICAL path (#258 Q3).

describe('#77 — notifications endpoints', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('apiGetNotifications GETs /notifications with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const list = { items: [], unreadCount: 0 };
    fetchMock.mockResolvedValue({ ok: true, json: async () => list } as unknown as Response);

    const result = await apiGetNotifications('token');

    expect(result).toEqual(list);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/notifications$/);
  });

  it('apiGetNotifications GETs /notifications?unread=true when unreadOnly is passed', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], unreadCount: 0 }) } as unknown as Response);

    await apiGetNotifications('token', { unreadOnly: true });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/notifications\?unread=true$/);
  });

  it('apiMarkNotificationRead POSTs to /notifications/:id/read', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as unknown as Response);

    await apiMarkNotificationRead('token', 'n-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/notifications\/n-1\/read$/);
    expect(init).toMatchObject({ method: 'POST' });
  });

  it('apiMarkNotificationRead throws INVALID_NOTIFICATION_ID verbatim on a 400', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'INVALID_NOTIFICATION_ID' }),
    } as unknown as Response);

    await expect(apiMarkNotificationRead('token', 'not-a-number')).rejects.toThrow('INVALID_NOTIFICATION_ID');
  });

  it('apiMarkNotificationRead throws NOTIFICATION_NOT_FOUND verbatim on a 404', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ code: 'NOTIFICATION_NOT_FOUND' }),
    } as unknown as Response);

    await expect(apiMarkNotificationRead('token', '999')).rejects.toThrow('NOTIFICATION_NOT_FOUND');
  });

  it('apiMarkAllNotificationsRead POSTs to /notifications/read-all', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ updated: 3 }) } as unknown as Response);

    const result = await apiMarkAllNotificationsRead('token');

    expect(result).toEqual({ updated: 3 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/notifications\/read-all$/);
    expect(init).toMatchObject({ method: 'POST' });
  });
});

describe('#86 — leave request endpoints', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('apiGetMyLeaveRequests GETs /me/leave-requests with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const view = { items: [], cursor: null, total: 0 };
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetMyLeaveRequests('token');

    expect(result).toEqual(view);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me\/leave-requests$/);
  });

  it('apiSubmitLeaveRequest POSTs the request body to /leave-requests', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const response = { result: 'OK', id: 'lr-1' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);
    const body = { seId: 'se-1', type: 'ON_LEAVE' as const, windowStart: '2026-08-10', windowEnd: '2026-08-12' };

    const result = await apiSubmitLeaveRequest('token', body);

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/leave-requests$/);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
  });

  it('apiSubmitLeaveRequest throws WINDOW_ORDER verbatim on a 400', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'WINDOW_ORDER' }),
    } as unknown as Response);

    await expect(
      apiSubmitLeaveRequest('token', { seId: 'se-1', type: 'ON_LEAVE', windowStart: '2026-08-12', windowEnd: '2026-08-10' }),
    ).rejects.toThrow('WINDOW_ORDER');
  });

  it('apiSubmitLeaveRequest throws INVALID_LEAVE_TYPE verbatim on a 400', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'INVALID_LEAVE_TYPE' }),
    } as unknown as Response);

    await expect(
      apiSubmitLeaveRequest('token', { seId: 'se-1', type: 'ON_LEAVE', windowStart: '2026-08-10', windowEnd: '2026-08-12' }),
    ).rejects.toThrow('INVALID_LEAVE_TYPE');
  });
});

describe('#87 — availability endpoints', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('apiGetMyAvailability GETs /me/availability with a Bearer token', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const view = { items: [], cursor: null, total: 0 };
    fetchMock.mockResolvedValue({ ok: true, json: async () => view } as unknown as Response);

    const result = await apiGetMyAvailability('token');

    expect(result).toEqual(view);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me\/availability$/);
  });

  it('apiSetAvailability POSTs the request body to /engineers/:seId/availability', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    const fetchMock = installFetchMock();
    const response = { result: 'OK', id: 'av-1' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => response } as unknown as Response);
    const body = { status: 'SOFT_UNAVAILABLE' as const, windowStart: '2026-08-10T00:00:00Z', windowEnd: '2026-08-12T00:00:00Z' };

    const result = await apiSetAvailability('token', 'se-1', body);

    expect(result).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/engineers\/se-1\/availability$/);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
  });

  it('apiSetAvailability throws WINDOW_END_REQUIRED verbatim on a 400', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'WINDOW_END_REQUIRED' }),
    } as unknown as Response);

    await expect(
      apiSetAvailability('token', 'se-1', { status: 'SOFT_UNAVAILABLE', windowStart: '2026-08-10T00:00:00Z', windowEnd: '' }),
    ).rejects.toThrow('WINDOW_END_REQUIRED');
  });

  it('apiSetAvailability throws AVAILABILITY_FORBIDDEN verbatim on a 403 (clearing a manager-set window)', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    installFetchMock().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ code: 'AVAILABILITY_FORBIDDEN' }),
    } as unknown as Response);

    await expect(
      apiSetAvailability('token', 'se-1', { status: 'AVAILABLE', windowStart: '2026-08-10T00:00:00Z', windowEnd: '2026-08-12T00:00:00Z' }),
    ).rejects.toThrow('AVAILABILITY_FORBIDDEN');
  });
});
