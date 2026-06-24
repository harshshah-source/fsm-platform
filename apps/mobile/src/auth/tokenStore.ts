import * as Keychain from 'react-native-keychain';
import type { LoginResponse } from '@fsm/shared';

// Mobile keeps the full token pair (access + refresh) in the device keychain — there is no
// httpOnly-cookie path on native (ADR-0025). One keychain entry holds the JSON token pair.
const SERVICE = 'fsm.tokens';
const ACCOUNT = 'fsm';

export async function setTokens(tokens: LoginResponse): Promise<void> {
  await Keychain.setGenericPassword(ACCOUNT, JSON.stringify(tokens), { service: SERVICE });
}

async function getTokens(): Promise<LoginResponse | null> {
  const stored = await Keychain.getGenericPassword({ service: SERVICE });
  if (!stored) {
    return null;
  }
  return JSON.parse(stored.password) as LoginResponse;
}

export async function getAccessToken(): Promise<string | null> {
  const tokens = await getTokens();
  return tokens?.accessToken ?? null;
}

export async function clearTokens(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}
