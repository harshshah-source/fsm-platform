import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Keychain from 'react-native-keychain';
import * as Crypto from 'expo-crypto';
import { getDeviceId } from './deviceId';

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(),
}));

const keychain = jest.mocked(Keychain);
const crypto = jest.mocked(Crypto);

describe('getDeviceId', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('generates a UUID and persists it to the keychain on first call', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    crypto.randomUUID.mockReturnValue('11111111-1111-1111-1111-111111111111');

    const id = await getDeviceId();

    expect(id).toBe('11111111-1111-1111-1111-111111111111');
    expect(keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    const [, password, options] = keychain.setGenericPassword.mock.calls[0];
    expect(password).toBe('11111111-1111-1111-1111-111111111111');
    expect(options).toMatchObject({ service: expect.any(String) });
  });

  it('returns the persisted id on subsequent calls without regenerating', async () => {
    keychain.getGenericPassword.mockResolvedValue({
      service: 'fsm.deviceId',
      username: 'fsm',
      password: '22222222-2222-2222-2222-222222222222',
      storage: 'keychain',
    } as unknown as Awaited<ReturnType<typeof Keychain.getGenericPassword>>);

    const id = await getDeviceId();

    expect(id).toBe('22222222-2222-2222-2222-222222222222');
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(keychain.setGenericPassword).not.toHaveBeenCalled();
  });

  it('uses a keychain service distinct from the token store, so a logout/clearTokens cannot wipe it', async () => {
    keychain.getGenericPassword.mockResolvedValue(false);
    crypto.randomUUID.mockReturnValue('33333333-3333-3333-3333-333333333333');

    await getDeviceId();

    const [, , options] = keychain.setGenericPassword.mock.calls[0];
    expect((options as { service: string }).service).not.toBe('fsm.tokens');
  });
});
