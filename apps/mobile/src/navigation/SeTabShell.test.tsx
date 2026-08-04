import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SeTabShell } from './SeTabShell';

// TicketsScreen (#56) and HomeScreen (#55) both read connectivity on mount. Offline-with-no-cache
// short-circuits before touching auth/client at all, which is all this suite needs — it only
// asserts the shell switches screens, not what a live fetch renders (see each screen's own test
// file for that).
jest.mock('../api/connectivity', () => ({
  getConnectivityState: jest.fn<() => Promise<'online' | 'offline'>>().mockResolvedValue('offline'),
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ session: null, loading: false, login: jest.fn(), logout: jest.fn() }),
}));

describe('SeTabShell', () => {
  it('boots to the Home tab and registers all five nav entries', async () => {
    render(<SeTabShell />);

    expect(screen.getByTestId('tab-Home')).toBeTruthy();
    expect(screen.getByTestId('tab-Tickets')).toBeTruthy();
    expect(screen.getByTestId('tab-Stock')).toBeTruthy();
    expect(screen.getByTestId('tab-Vouchers')).toBeTruthy();
    expect(screen.getByTestId('tab-Profile')).toBeTruthy();
    expect(screen.getByTestId('screen-home')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-offline-badge')).toBeTruthy());
  });

  it('switches screens when a different tab is pressed', async () => {
    render(<SeTabShell />);

    fireEvent.press(screen.getByTestId('tab-Tickets'));

    expect(screen.getByTestId('screen-tickets')).toBeTruthy();
    expect(screen.queryByTestId('screen-home')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('tickets-offline-banner')).toBeTruthy());
  });
});
