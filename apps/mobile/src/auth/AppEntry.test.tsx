import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import type { SessionView } from '@fsm/shared';
import { AppEntry } from './AppEntry';
import { useAuth } from './AuthProvider';

jest.mock('./AuthProvider', () => ({ useAuth: jest.fn() }));

const mockUseAuth = jest.mocked(useAuth);

function setAuth(session: SessionView | null) {
  mockUseAuth.mockReturnValue({
    session,
    login: jest.fn<(email: string, password: string) => Promise<void>>(),
    logout: jest.fn<() => Promise<void>>(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AppEntry', () => {
  it('renders the login screen when there is no session', () => {
    setAuth(null);
    render(<AppEntry />);

    expect(screen.getByTestId('email-input')).toBeTruthy();
    expect(screen.queryByTestId('logout')).toBeNull();
  });

  it('renders the session screen when authenticated', () => {
    setAuth({ user_id: 'u-1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null });
    render(<AppEntry />);

    expect(screen.getByTestId('logout')).toBeTruthy();
    expect(screen.getByText('ZONAL_MANAGER')).toBeTruthy();
    expect(screen.queryByTestId('email-input')).toBeNull();
  });
});
