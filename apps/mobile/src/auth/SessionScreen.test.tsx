import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SessionView } from '@fsm/shared';
import { SessionScreen } from './SessionScreen';
import { useAuth } from './AuthProvider';

jest.mock('./AuthProvider', () => ({ useAuth: jest.fn() }));

const mockUseAuth = jest.mocked(useAuth);
const mockLogout = jest.fn<() => Promise<void>>();

function setSession(session: SessionView | null) {
  mockUseAuth.mockReturnValue({
    session,
    login: jest.fn<(e: string, p: string) => Promise<void>>(),
    logout: mockLogout,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SessionScreen', () => {
  it('renders the role and zone label for a zoned session', () => {
    setSession({ user_id: 'u-1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null });
    render(<SessionScreen />);

    expect(screen.getByText('ZONAL_MANAGER')).toBeTruthy();
    expect(screen.getByText('Zone 1')).toBeTruthy();
  });

  it('renders "All zones" when zone_id is null', () => {
    setSession({ user_id: 'u-2', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null });
    render(<SessionScreen />);

    expect(screen.getByText('All zones')).toBeTruthy();
  });

  it('shows the acting banner only when acted_as_role is set', () => {
    setSession({ user_id: 'u-3', role: 'ZONAL_MANAGER', zone_id: 2, acted_as_role: 'CENTRAL_SERVICE_MANAGER' });
    const { rerender } = render(<SessionScreen />);
    expect(screen.getByText('Acting as CENTRAL_SERVICE_MANAGER')).toBeTruthy();

    setSession({ user_id: 'u-3', role: 'ZONAL_MANAGER', zone_id: 2, acted_as_role: null });
    rerender(<SessionScreen />);
    expect(screen.queryByText(/Acting as/)).toBeNull();
  });

  it('logout button invokes logout()', () => {
    setSession({ user_id: 'u-1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null });
    render(<SessionScreen />);

    fireEvent.press(screen.getByTestId('logout'));

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there is no session', () => {
    setSession(null);
    render(<SessionScreen />);

    expect(screen.queryByTestId('logout')).toBeNull();
  });
});
