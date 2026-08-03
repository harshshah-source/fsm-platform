import * as Keychain from 'react-native-keychain';
import * as Crypto from 'expo-crypto';

// #54 non-retrofittable: the server's D-2 one-active-device policy (#91) binds each session to a
// device via `refresh_tokens.device_id`, and this is the only source of that id. A distinct keychain
// service from `fsm.tokens` (tokenStore.ts) so a logout/clearTokens can never wipe the install id —
// it must survive logout and re-login, regenerating only on reinstall.
const SERVICE = 'fsm.deviceId';
const ACCOUNT = 'fsm';

export async function getDeviceId(): Promise<string> {
  const stored = await Keychain.getGenericPassword({ service: SERVICE });
  if (stored) {
    return stored.password;
  }
  const id = Crypto.randomUUID();
  await Keychain.setGenericPassword(ACCOUNT, id, { service: SERVICE });
  return id;
}
