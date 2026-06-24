import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Button, Text } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { LoginResponse, SessionView } from '@fsm/shared';
import { AuthProvider, useAuth } from './AuthProvider';
import { apiLogin, apiMe } from '../api/client';
import { clearTokens, setTokens } from './tokenStore';

jest.mock('../api/client', () => ({
  apiLogin: jest.fn(),
  apiMe: jest.fn(),
}));
jest.mock('./tokenStore', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(),
}));

const mockApiLogin = jest.mocked(apiLogin);
const mockApiMe = jest.mocked(apiMe);
const mockSetTokens = jest.mocked(setTokens);
const mockClearTokens = jest.mocked(clearTokens);

const tokens: LoginResponse = { accessToken: 'header.payload.sig', refreshToken: 'refresh.token.value' };
const session: SessionView = { user_id: 'u-1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function Harness() {
  const { session: s, login, logout } = useAuth();
  return (
    <>
      <Text>{s ? `role:${s.role}` : 'role:none'}</Text>
      <Text>{s ? `zone:${s.zone_id}` : 'zone:none'}</Text>
      <Button title="do-login" onPress={() => void login('zm.north@fsm.test', 'correct-password')} />
      <Button title="do-logout" onPress={() => void logout()} />
    </>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApiLogin.mockResolvedValue(tokens);
    mockApiMe.mockResolvedValue(session);
  });

  it('login stores the tokens in the keychain and exposes the session from /me', async () => {
    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    expect(screen.getByText('role:none')).toBeTruthy();

    fireEvent.press(screen.getByText('do-login'));

    await waitFor(() => expect(screen.getByText('role:ZONAL_MANAGER')).toBeTruthy());
    expect(mockApiLogin).toHaveBeenCalledWith({ email: 'zm.north@fsm.test', password: 'correct-password' });
    expect(mockSetTokens).toHaveBeenCalledWith(tokens);
    expect(mockApiMe).toHaveBeenCalledWith(tokens.accessToken);
    expect(screen.getByText('zone:1')).toBeTruthy();
  });

  it('logout clears the keychain and resets the session', async () => {
    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    fireEvent.press(screen.getByText('do-login'));
    await waitFor(() => expect(screen.getByText('role:ZONAL_MANAGER')).toBeTruthy());

    fireEvent.press(screen.getByText('do-logout'));

    await waitFor(() => expect(screen.getByText('role:none')).toBeTruthy());
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  it('useAuth throws when used outside an AuthProvider', () => {
    expect(() => render(<Harness />)).toThrow('useAuth must be used within AuthProvider');
  });
});
