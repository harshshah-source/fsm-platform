import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { NotificationList, NotificationListItem } from '@fsm/shared';
import { NotificationsScreen } from './NotificationsScreen';
import { apiGetNotifications, apiMarkAllNotificationsRead, apiMarkNotificationRead } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';

jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client') as object;
  return {
    ...actual,
    apiGetNotifications: jest.fn(),
    apiMarkNotificationRead: jest.fn(),
    apiMarkAllNotificationsRead: jest.fn(),
  };
});
jest.mock('../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../tickets/detail/TicketDetailScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    TicketDetailScreen: ({ ticketId, onBack }: { ticketId: string; onBack: () => void }) => (
      <>
        <Text testID="mock-detail-ticket-id">{ticketId}</Text>
        <Text testID="mock-detail-back" onPress={onBack}>
          Back
        </Text>
      </>
    ),
  };
});

const mockGetNotifications = jest.mocked(apiGetNotifications);
const mockMarkRead = jest.mocked(apiMarkNotificationRead);
const mockMarkAllRead = jest.mocked(apiMarkAllNotificationsRead);
const mockGetAccessToken = jest.mocked(getAccessToken);

function item(overrides: Partial<NotificationListItem> = {}): NotificationListItem {
  return {
    id: 'n-1',
    type: 'INTRADAY_CRITICAL_OFFER',
    title: 'Urgent CRITICAL ticket offered',
    body: 'Ticket t-1 needs a response within 10 minutes.',
    entityType: 'ticket',
    entityId: 't-1',
    metadata: null,
    read: false,
    readAt: null,
    createdAt: '2026-08-04T06:00:00Z',
    ...overrides,
  };
}

describe('NotificationsScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the notification list with title and body', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({ items: [item()], unreadCount: 1 });

    render(<NotificationsScreen onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Urgent CRITICAL ticket offered')).toBeTruthy());
    expect(screen.getByText('Ticket t-1 needs a response within 10 minutes.')).toBeTruthy();
  });

  it('shows an empty state when there are no notifications', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({ items: [], unreadCount: 0 });

    render(<NotificationsScreen onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('notifications-empty')).toBeTruthy());
  });

  it('narrows to unread-only when the Unread filter is pressed', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({ items: [item()], unreadCount: 1 });

    render(<NotificationsScreen onBack={jest.fn()} />);
    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalledWith('token', { unreadOnly: false }));

    fireEvent.press(screen.getByTestId('notifications-filter-UNREAD'));

    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalledWith('token', { unreadOnly: true }));
  });

  it('tapping a notification marks it read and routes to Ticket Detail for a ticket entity', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({ items: [item()], unreadCount: 1 });
    mockMarkRead.mockResolvedValue(undefined);

    render(<NotificationsScreen onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Urgent CRITICAL ticket offered')).toBeTruthy());

    fireEvent.press(screen.getByTestId('notification-item-n-1'));

    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith('token', 'n-1'));
    await waitFor(() => expect(screen.getByTestId('mock-detail-ticket-id')).toBeTruthy());
    expect(screen.getByTestId('mock-detail-ticket-id').props.children).toBe('t-1');
  });

  it('tapping a notification with no entity only marks it read, no navigation', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({
      items: [item({ id: 'n-2', entityType: null, entityId: null, title: 'General notice' })],
      unreadCount: 1,
    });
    mockMarkRead.mockResolvedValue(undefined);

    render(<NotificationsScreen onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('General notice')).toBeTruthy());

    fireEvent.press(screen.getByTestId('notification-item-n-2'));

    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith('token', 'n-2'));
    expect(screen.queryByTestId('mock-detail-ticket-id')).toBeNull();
  });

  it('returns from Ticket Detail to the notification list on back', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({ items: [item()], unreadCount: 1 });
    mockMarkRead.mockResolvedValue(undefined);

    render(<NotificationsScreen onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Urgent CRITICAL ticket offered')).toBeTruthy());
    fireEvent.press(screen.getByTestId('notification-item-n-1'));
    await waitFor(() => expect(screen.getByTestId('mock-detail-ticket-id')).toBeTruthy());

    fireEvent.press(screen.getByTestId('mock-detail-back'));

    expect(screen.getByTestId('screen-notifications')).toBeTruthy();
  });

  it('Mark All Read posts read-all and refetches', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({ items: [item()], unreadCount: 1 });
    mockMarkAllRead.mockResolvedValue({ updated: 1 });

    render(<NotificationsScreen onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('notifications-mark-all-read')).toBeTruthy());

    fireEvent.press(screen.getByTestId('notifications-mark-all-read'));

    await waitFor(() => expect(mockMarkAllRead).toHaveBeenCalledWith('token'));
    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalledTimes(2));
  });

  it('calls onBack when the back button is pressed', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetNotifications.mockResolvedValue({ items: [], unreadCount: 0 } as NotificationList);
    const onBack = jest.fn();

    render(<NotificationsScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('notifications-back')).toBeTruthy());

    fireEvent.press(screen.getByTestId('notifications-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
