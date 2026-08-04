import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import type { SessionView } from '@fsm/shared';
import { AppEntry } from './AppEntry';
import { useAuth } from './AuthProvider';

jest.mock('./AuthProvider', () => ({ useAuth: jest.fn() }));
// The SE tab shell's default Home tab (#55) reads connectivity on mount — offline-with-no-cache
// short-circuits before touching the client, which is all this suite needs (see HomeScreen's own
// test file for live-data behavior).
jest.mock('../api/connectivity', () => ({
  getConnectivityState: jest.fn<() => Promise<'online' | 'offline'>>().mockResolvedValue('offline'),
}));
// #77 — SeTabShell's one-time intraday-offer/ghost-toast check on mount. No token here, so it
// short-circuits before touching the client — see SeTabShell's own test file for that behavior.
jest.mock('../auth/tokenStore', () => ({ getAccessToken: jest.fn<() => Promise<string | null>>().mockResolvedValue(null) }));

const mockUseAuth = jest.mocked(useAuth);

function setAuth(session: SessionView | null, loading = false) {
  mockUseAuth.mockReturnValue({
    session,
    loading,
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

  it('renders the SE tab shell when authenticated as SERVICE_ENGINEER', async () => {
    setAuth({ user_id: 'se-1', role: 'SERVICE_ENGINEER', zone_id: 1, acted_as_role: null });
    render(<AppEntry />);

    await waitFor(() => expect(screen.getByTestId('screen-home')).toBeTruthy());
    expect(screen.getByTestId('tab-Tickets')).toBeTruthy();
    expect(screen.queryByTestId('logout')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('home-offline-badge')).toBeTruthy());
  });

  it('renders neither screen while rehydrating, even with no session yet', () => {
    setAuth(null, true);
    render(<AppEntry />);

    expect(screen.getByTestId('rehydrating')).toBeTruthy();
    expect(screen.queryByTestId('email-input')).toBeNull();
    expect(screen.queryByTestId('logout')).toBeNull();
  });
});
