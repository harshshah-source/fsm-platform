import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Button, Text } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { LoginResponse, SessionView } from '@fsm/shared';
import { AuthProvider, useAuth } from './AuthProvider';
import { apiLogin, apiMe, apiRefresh } from '../api/client';
import { clearTokens, getTokens, setTokens } from './tokenStore';

jest.mock('../api/client', () => ({
  apiLogin: jest.fn(),
  apiMe: jest.fn(),
  apiRefresh: jest.fn(),
}));
jest.mock('./tokenStore', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getTokens: jest.fn(),
}));

const mockApiLogin = jest.mocked(apiLogin);
const mockApiMe = jest.mocked(apiMe);
const mockApiRefresh = jest.mocked(apiRefresh);
const mockSetTokens = jest.mocked(setTokens);
const mockClearTokens = jest.mocked(clearTokens);
const mockGetTokens = jest.mocked(getTokens);

const tokens: LoginResponse = { accessToken: 'header.payload.sig', refreshToken: 'refresh.token.value' };
const refreshedTokens: LoginResponse = { accessToken: 'new.access.sig', refreshToken: 'new.refresh.value' };
const session: SessionView = { user_id: 'u-1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

function Harness() {
  const { session: s, loading, login, logout } = useAuth();
  return (
    <>
      <Text>{loading ? 'loading:yes' : 'loading:no'}</Text>
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
    mockGetTokens.mockResolvedValue(null);
  });

  it('login stores the tokens in the keychain and exposes the session from /me', async () => {
    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('loading:no')).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText('loading:no')).toBeTruthy());
    fireEvent.press(screen.getByText('do-login'));
    await waitFor(() => expect(screen.getByText('role:ZONAL_MANAGER')).toBeTruthy());

    fireEvent.press(screen.getByText('do-logout'));

    await waitFor(() => expect(screen.getByText('role:none')).toBeTruthy());
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  it('useAuth throws when used outside an AuthProvider', () => {
    expect(() => render(<Harness />)).toThrow('useAuth must be used within AuthProvider');
  });

  it('is loading until the rehydration check resolves, then reports no session when none is stored', async () => {
    let resolveGetTokens: (value: LoginResponse | null) => void = () => {};
    mockGetTokens.mockReturnValue(
      new Promise((resolve) => {
        resolveGetTokens = resolve;
      }),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    expect(screen.getByText('loading:yes')).toBeTruthy();

    resolveGetTokens(null);

    await waitFor(() => expect(screen.getByText('loading:no')).toBeTruthy());
    expect(screen.getByText('role:none')).toBeTruthy();
    expect(mockApiMe).not.toHaveBeenCalled();
  });

  it('rehydrates the session from a stored token pair on mount, without a fresh login', async () => {
    mockGetTokens.mockResolvedValue(tokens);

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('role:ZONAL_MANAGER')).toBeTruthy());
    expect(screen.getByText('loading:no')).toBeTruthy();
    expect(mockApiMe).toHaveBeenCalledWith(tokens.accessToken);
    expect(mockApiLogin).not.toHaveBeenCalled();
  });

  it('refreshes and retries on a 401 during rehydration, persisting the rotated pair', async () => {
    mockGetTokens.mockResolvedValue(tokens);
    mockApiMe.mockRejectedValueOnce(new Error('UNAUTHORIZED'));
    mockApiMe.mockResolvedValueOnce(session);
    mockApiRefresh.mockResolvedValue(refreshedTokens);

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('role:ZONAL_MANAGER')).toBeTruthy());
    expect(mockApiRefresh).toHaveBeenCalledWith(tokens.refreshToken);
    expect(mockSetTokens).toHaveBeenCalledWith(refreshedTokens);
    expect(mockApiMe).toHaveBeenLastCalledWith(refreshedTokens.accessToken);
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  it('clears the stored tokens and stays logged out when the refresh attempt also fails', async () => {
    mockGetTokens.mockResolvedValue(tokens);
    mockApiMe.mockRejectedValue(new Error('UNAUTHORIZED'));
    mockApiRefresh.mockRejectedValue(new Error('UNAUTHORIZED'));

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('loading:no')).toBeTruthy());
    expect(screen.getByText('role:none')).toBeTruthy();
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });
});
