import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { SessionView } from '@fsm/shared';
import { ProfileScreen } from './ProfileScreen';
import { useAuth } from '../../auth/AuthProvider';

jest.mock('../../auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('./LeaveRequestScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    LeaveRequestScreen: ({ onBack }: { onBack: () => void }) => (
      <Text testID="mock-leave-requests-screen" onPress={onBack}>
        Leave Requests
      </Text>
    ),
  };
});
jest.mock('./AvailabilityScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    AvailabilityScreen: ({ seId, onBack }: { seId: string; onBack: () => void }) => (
      <Text testID="mock-availability-screen" onPress={onBack}>
        Availability for {seId}
      </Text>
    ),
  };
});

const mockUseAuth = jest.mocked(useAuth);
const session: SessionView = { user_id: 'se-1', role: 'SERVICE_ENGINEER', zone_id: 3, acted_as_role: null };

describe('ProfileScreen', () => {
  it('renders the Profile screen with Leave Request, Availability and Logout entry points', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false, logout: jest.fn() } as never);

    render(<ProfileScreen />);

    expect(screen.getByTestId('screen-profile')).toBeTruthy();
    expect(screen.getByTestId('profile-leave-requests-button')).toBeTruthy();
    expect(screen.getByTestId('profile-availability-button')).toBeTruthy();
    expect(screen.getByTestId('profile-logout-button')).toBeTruthy();
    expect(screen.getByText('Logout')).toBeTruthy();
  });

  it('calls the AuthProvider logout when the Logout pill is pressed', () => {
    const logout = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue({ session, isLoading: false, logout } as never);

    render(<ProfileScreen />);
    fireEvent.press(screen.getByTestId('profile-logout-button'));

    // No navigation call here by design — AppEntry swaps to LoginScreen the instant the session
    // clears, so this screen's only job is to invoke the session's own logout.
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('opens LeaveRequestScreen when pressed, and returns to Profile on back', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);

    render(<ProfileScreen />);

    fireEvent.press(screen.getByTestId('profile-leave-requests-button'));

    expect(screen.getByTestId('mock-leave-requests-screen')).toBeTruthy();
    expect(screen.queryByTestId('screen-profile')).toBeNull();

    fireEvent.press(screen.getByTestId('mock-leave-requests-screen'));

    expect(screen.getByTestId('screen-profile')).toBeTruthy();
  });

  it('opens AvailabilityScreen with the caller\'s own seId when pressed, and returns to Profile on back', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);

    render(<ProfileScreen />);

    fireEvent.press(screen.getByTestId('profile-availability-button'));

    expect(screen.getByText('Availability for se-1')).toBeTruthy();
    expect(screen.queryByTestId('screen-profile')).toBeNull();

    fireEvent.press(screen.getByTestId('mock-availability-screen'));

    expect(screen.getByTestId('screen-profile')).toBeTruthy();
  });
});
