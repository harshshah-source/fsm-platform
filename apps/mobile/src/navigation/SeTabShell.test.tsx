import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import type { IntradayInsertionOffer, NotificationListItem } from '@fsm/shared';
import { SeTabShell } from './SeTabShell';
import { apiGetMyIntradayOffers, apiGetNotifications, apiMarkNotificationRead } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';

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
jest.mock('../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client') as object;
  return {
    ...actual,
    apiGetMyIntradayOffers: jest.fn(),
    apiGetNotifications: jest.fn(),
    apiMarkNotificationRead: jest.fn(),
  };
});
jest.mock('../intraday/IntradayOfferScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    IntradayOfferScreen: ({ onResolved }: { onResolved: (id: string | null) => void }) => (
      <Text testID="mock-intraday-offer" onPress={() => onResolved('accepted-t-1')}>
        Intraday Offer
      </Text>
    ),
  };
});

const mockGetAccessToken = jest.mocked(getAccessToken);
const mockGetMyIntradayOffers = jest.mocked(apiGetMyIntradayOffers);
const mockGetNotifications = jest.mocked(apiGetNotifications);
const mockMarkNotificationRead = jest.mocked(apiMarkNotificationRead);

const NO_OFFERS = { items: [], cursor: null };
const NO_NOTIFICATIONS = { items: [], unreadCount: 0 };

function offer(overrides: Partial<IntradayInsertionOffer> = {}): IntradayInsertionOffer {
  return {
    insertionId: 'i-1',
    ticketId: 't-1',
    zoneId: 'z-1',
    companyId: 'co-1',
    companyTier: 'GOLD',
    insertionType: 'SYSTEM_CRITICAL',
    slaBucket: 'CRITICAL',
    offeredSeId: 'se-1',
    offeredAt: '2026-08-04T06:00:00Z',
    acceptanceDeadline: '2026-08-04T06:10:00Z',
    status: 'PENDING_ACCEPTANCE',
    declineReasonCode: null,
    retryCount: 0,
    whatsappSent: false,
    createdAt: '2026-08-04T06:00:00Z',
    ...overrides,
  };
}

function ghostNotification(overrides: Partial<NotificationListItem> = {}): NotificationListItem {
  return {
    id: 'n-1',
    type: 'INTRADAY_GHOST_ASSIGNMENT',
    title: 'Offer routed on',
    body: 'Ticket t-1 was offered to you and routed to Priya S. because you did not respond in time.',
    entityType: 'ticket',
    entityId: 't-1',
    metadata: null,
    read: false,
    readAt: null,
    createdAt: '2026-08-04T06:11:00Z',
    ...overrides,
  };
}

describe('SeTabShell', () => {
  beforeEach(() => {
    mockGetAccessToken.mockResolvedValue(null);
    mockGetMyIntradayOffers.mockResolvedValue(NO_OFFERS);
    mockGetNotifications.mockResolvedValue(NO_NOTIFICATIONS);
  });

  it('boots to the Home tab and registers all five nav entries', async () => {
    render(<SeTabShell />);

    await waitFor(() => expect(screen.getByTestId('tab-Home')).toBeTruthy());
    expect(screen.getByTestId('tab-Tickets')).toBeTruthy();
    expect(screen.getByTestId('tab-Stock')).toBeTruthy();
    expect(screen.getByTestId('tab-Vouchers')).toBeTruthy();
    expect(screen.getByTestId('tab-Profile')).toBeTruthy();
    expect(screen.getByTestId('screen-home')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-offline-badge')).toBeTruthy());
  });

  it('switches screens when a different tab is pressed', async () => {
    render(<SeTabShell />);

    await waitFor(() => expect(screen.getByTestId('tab-Tickets')).toBeTruthy());
    fireEvent.press(screen.getByTestId('tab-Tickets'));

    expect(screen.getByTestId('screen-tickets')).toBeTruthy();
    expect(screen.queryByTestId('screen-home')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('tickets-offline-banner')).toBeTruthy());
  });

  describe('#77 — intraday offer gate + ghost-assignment toast', () => {
    it('renders no tabs and shows the full-screen offer prompt when a PENDING offer exists', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetMyIntradayOffers.mockResolvedValue({ items: [offer()], cursor: null });

      render(<SeTabShell />);

      await waitFor(() => expect(screen.getByTestId('mock-intraday-offer')).toBeTruthy());
      expect(screen.queryByTestId('tab-Home')).toBeNull();
    });

    it('shows the tab navigator once the offer resolves, with the accepted ticketId threaded to Tickets', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetMyIntradayOffers.mockResolvedValue({ items: [offer()], cursor: null });

      render(<SeTabShell />);
      await waitFor(() => expect(screen.getByTestId('mock-intraday-offer')).toBeTruthy());

      fireEvent.press(screen.getByTestId('mock-intraday-offer'));

      await waitFor(() => expect(screen.getByTestId('tab-Home')).toBeTruthy());
      expect(screen.queryByTestId('mock-intraday-offer')).toBeNull();
    });

    it('does not gate the tabs when there is no pending offer', async () => {
      mockGetAccessToken.mockResolvedValue('token');

      render(<SeTabShell />);

      await waitFor(() => expect(screen.getByTestId('tab-Home')).toBeTruthy());
      expect(screen.queryByTestId('mock-intraday-offer')).toBeNull();
    });

    it('shows a dismissible ghost-assignment toast once ready, and marks it read on dismiss', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetNotifications.mockResolvedValue({ items: [ghostNotification()], unreadCount: 1 });

      render(<SeTabShell />);

      await waitFor(() => expect(screen.getByTestId('ghost-assignment-toast')).toBeTruthy());
      expect(screen.getByText(ghostNotification().body as string)).toBeTruthy();

      fireEvent.press(screen.getByTestId('ghost-assignment-toast-dismiss'));

      await waitFor(() => expect(mockMarkNotificationRead).toHaveBeenCalledWith('token', 'n-1'));
      expect(screen.queryByTestId('ghost-assignment-toast')).toBeNull();
    });

    it('shows no toast when there is no unread ghost-assignment notification', async () => {
      mockGetAccessToken.mockResolvedValue('token');

      render(<SeTabShell />);

      await waitFor(() => expect(screen.getByTestId('tab-Home')).toBeTruthy());
      expect(screen.queryByTestId('ghost-assignment-toast')).toBeNull();
    });
  });
});
