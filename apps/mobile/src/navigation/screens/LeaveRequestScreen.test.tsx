import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { LeaveRequestRow } from '@fsm/shared';
import { LeaveRequestScreen } from './LeaveRequestScreen';
import { apiGetMyLeaveRequests } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiGetMyLeaveRequests: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../../leave/LeaveRequestFormScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    LeaveRequestFormScreen: ({ onSubmitted }: { onSubmitted: () => void }) => (
      <Text testID="mock-leave-form" onPress={onSubmitted}>
        Leave Request Form
      </Text>
    ),
  };
});

const mockGetMyLeaveRequests = jest.mocked(apiGetMyLeaveRequests);
const mockGetAccessToken = jest.mocked(getAccessToken);

function row(overrides: Partial<LeaveRequestRow> = {}): LeaveRequestRow {
  return {
    id: 'lr-1',
    seId: 'se-1',
    seName: 'Rahul',
    type: 'ON_LEAVE',
    status: 'PENDING',
    windowStart: '2026-08-10T00:00:00Z',
    windowEnd: '2026-08-12T00:00:00Z',
    reason: null,
    decisionReason: null,
    createdAt: '2026-08-04T00:00:00Z',
    ...overrides,
  };
}

describe('LeaveRequestScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the leave request list with type and status', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyLeaveRequests.mockResolvedValue({ items: [row()], cursor: null });

    render(<LeaveRequestScreen onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('leave-row-lr-1')).toBeTruthy());
    expect(screen.getByText('On Leave')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('shows an empty state when there are no leave requests', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyLeaveRequests.mockResolvedValue({ items: [], cursor: null });

    render(<LeaveRequestScreen onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('leave-requests-empty')).toBeTruthy());
  });

  it('shows the decision reason for a REJECTED request', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyLeaveRequests.mockResolvedValue({
      items: [row({ status: 'REJECTED', decisionReason: 'Coverage gap on those dates' })],
      cursor: null,
    });

    render(<LeaveRequestScreen onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Coverage gap on those dates')).toBeTruthy());
  });

  it('opens the New Leave Request form and returns to the list, refetching, on submit', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyLeaveRequests.mockResolvedValue({ items: [], cursor: null });

    render(<LeaveRequestScreen onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('leave-new-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('leave-new-button'));
    expect(screen.getByTestId('mock-leave-form')).toBeTruthy();

    mockGetMyLeaveRequests.mockResolvedValueOnce({ items: [row()], cursor: null });
    fireEvent.press(screen.getByTestId('mock-leave-form'));

    await waitFor(() => expect(mockGetMyLeaveRequests).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('mock-leave-form')).toBeNull();
  });

  it('calls onBack when the back button is pressed', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyLeaveRequests.mockResolvedValue({ items: [], cursor: null });
    const onBack = jest.fn();

    render(<LeaveRequestScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('leave-requests-back')).toBeTruthy());

    fireEvent.press(screen.getByTestId('leave-requests-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
