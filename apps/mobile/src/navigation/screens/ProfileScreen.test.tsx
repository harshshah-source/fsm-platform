import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ProfileScreen } from './ProfileScreen';

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

describe('ProfileScreen', () => {
  it('renders the Profile screen with a Leave Request entry point', () => {
    render(<ProfileScreen />);

    expect(screen.getByTestId('screen-profile')).toBeTruthy();
    expect(screen.getByTestId('profile-leave-requests-button')).toBeTruthy();
  });

  it('opens LeaveRequestScreen when pressed, and returns to Profile on back', () => {
    render(<ProfileScreen />);

    fireEvent.press(screen.getByTestId('profile-leave-requests-button'));

    expect(screen.getByTestId('mock-leave-requests-screen')).toBeTruthy();
    expect(screen.queryByTestId('screen-profile')).toBeNull();

    fireEvent.press(screen.getByTestId('mock-leave-requests-screen'));

    expect(screen.getByTestId('screen-profile')).toBeTruthy();
  });
});
