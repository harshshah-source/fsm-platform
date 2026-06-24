import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Keychain from 'react-native-keychain';
import type { LoginResponse } from '@fsm/shared';
import { clearTokens, getAccessToken, setTokens } from './tokenStore';

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));

const keychain = jest.mocked(Keychain);

type StoredCredentials = Awaited<ReturnType<typeof Keychain.getGenericPassword>>;

describe('tokenStore', () => {
  const tokens: LoginResponse = { accessToken: 'header.payload.sig', refreshToken: 'refresh.token.value' };

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('setTokens persists the access + refresh pair to the keychain', async () => {
    await setTokens(tokens);

    expect(keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    const [account, password, options] = keychain.setGenericPassword.mock.calls[0];
    expect(typeof account).toBe('string');
    expect(password).toBe(JSON.stringify(tokens));
    expect(options).toMatchObject({ service: expect.any(String) });
  });

  it('getAccessToken returns the stored access token', async () => {
    keychain.getGenericPassword.mockResolvedValue({
      service: 'fsm.tokens',
      username: 'fsm',
      password: JSON.stringify(tokens),
      storage: 'keychain',
    } as unknown as StoredCredentials);

    await expect(getAccessToken()).resolves.toBe('header.payload.sig');
  });

  it('getAccessToken returns null when the keychain is empty', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);

    await expect(getAccessToken()).resolves.toBeNull();
  });

  it('clearTokens removes the keychain entry', async () => {
    await clearTokens();

    expect(keychain.resetGenericPassword).toHaveBeenCalledTimes(1);
  });
});
