import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SeTabShell } from './SeTabShell';

// TicketsScreen (#56) reads connectivity on mount. Offline-with-no-cache short-circuits before
// touching auth/client at all, which is all this suite needs — it only asserts the shell switches
// screens, not what a live Tickets fetch renders (see TicketsScreen.test.tsx for that).
jest.mock('../api/connectivity', () => ({
  getConnectivityState: jest.fn<() => Promise<'online' | 'offline'>>().mockResolvedValue('offline'),
}));

describe('SeTabShell', () => {
  it('boots to the Home tab and registers all five nav entries', () => {
    render(<SeTabShell />);

    expect(screen.getByTestId('tab-Home')).toBeTruthy();
    expect(screen.getByTestId('tab-Tickets')).toBeTruthy();
    expect(screen.getByTestId('tab-Stock')).toBeTruthy();
    expect(screen.getByTestId('tab-Vouchers')).toBeTruthy();
    expect(screen.getByTestId('tab-Profile')).toBeTruthy();
    expect(screen.getByTestId('screen-home')).toBeTruthy();
  });

  it('switches screens when a different tab is pressed', async () => {
    render(<SeTabShell />);

    fireEvent.press(screen.getByTestId('tab-Tickets'));

    expect(screen.getByTestId('screen-tickets')).toBeTruthy();
    expect(screen.queryByTestId('screen-home')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('tickets-offline-banner')).toBeTruthy());
  });
});
