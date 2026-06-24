import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { LoginResponse, SessionView } from '@fsm/shared';
import { apiLogin, apiMe } from './client';

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

  it('throws INVALID_CREDENTIALS when the server rejects the login', async () => {
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
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue({ ok: true, json: async () => session } as unknown as Response);

    const result = await apiMe('header.payload.sig');

    expect(result).toEqual(session);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/me$/);
    expect(init).toMatchObject({
      headers: { Authorization: 'Bearer header.payload.sig' },
    });
  });

  it('throws UNAUTHORIZED when the token is rejected', async () => {
    installFetchMock().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);

    await expect(apiMe('bad-token')).rejects.toThrow('UNAUTHORIZED');
  });
});
