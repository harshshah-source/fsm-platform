import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { LoginScreen } from './LoginScreen';
import { useAuth } from './AuthProvider';

jest.mock('./AuthProvider', () => ({ useAuth: jest.fn() }));

const mockUseAuth = jest.mocked(useAuth);
const mockLogin = jest.fn<(email: string, password: string) => Promise<void>>();

beforeEach(() => {
  jest.clearAllMocks();
  mockLogin.mockResolvedValue(undefined);
  mockUseAuth.mockReturnValue({
    session: null,
    login: mockLogin,
    logout: jest.fn<() => Promise<void>>(),
  });
});

describe('LoginScreen', () => {
  it('submits the entered credentials to login()', async () => {
    render(<LoginScreen />);

    fireEvent.changeText(screen.getByTestId('email-input'), 'zm.north@fsm.test');
    fireEvent.changeText(screen.getByTestId('password-input'), 'correct-password');
    fireEvent.press(screen.getByTestId('submit'));

    await waitFor(() =>
      expect(mockLogin).toHaveBeenCalledWith('zm.north@fsm.test', 'correct-password'),
    );
  });

  it('shows an error message when login is rejected', async () => {
    mockLogin.mockRejectedValue(new Error('INVALID_CREDENTIALS'));
    render(<LoginScreen />);

    fireEvent.changeText(screen.getByTestId('email-input'), 'x@y.z');
    fireEvent.changeText(screen.getByTestId('password-input'), 'wrong');
    fireEvent.press(screen.getByTestId('submit'));

    await waitFor(() => expect(screen.getByText('Invalid email or password')).toBeTruthy());
  });
});
