import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { SessionView } from '@fsm/shared';
import { LeaveRequestFormScreen } from './LeaveRequestFormScreen';
import { apiSubmitLeaveRequest } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { getAccessToken } from '../auth/tokenStore';

jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client') as object;
  return { ...actual, apiSubmitLeaveRequest: jest.fn() };
});
jest.mock('../auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockSubmit = jest.mocked(apiSubmitLeaveRequest);
const mockUseAuth = jest.mocked(useAuth);
const mockGetAccessToken = jest.mocked(getAccessToken);

const session: SessionView = { user_id: 'se-1', role: 'SERVICE_ENGINEER', zone_id: 3, acted_as_role: null };

describe('LeaveRequestFormScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the ON_LEAVE and WEEKLY_OFF type tiles', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);

    render(<LeaveRequestFormScreen onSubmitted={jest.fn()} onCancel={jest.fn()} />);

    expect(screen.getByTestId('leave-type-tile-ON_LEAVE')).toBeTruthy();
    expect(screen.getByTestId('leave-type-tile-WEEKLY_OFF')).toBeTruthy();
  });

  it('disables submit until type, start, and end are all present', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);

    render(<LeaveRequestFormScreen onSubmitted={jest.fn()} onCancel={jest.fn()} />);

    expect(screen.getByTestId('leave-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('leave-type-tile-ON_LEAVE'));
    fireEvent.changeText(screen.getByTestId('leave-window-start-input'), '2026-08-10');
    expect(screen.getByTestId('leave-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('leave-window-end-input'), '2026-08-12');
    expect(screen.getByTestId('leave-submit').props.accessibilityState.disabled).toBe(false);
  });

  it('submits self seId, type, window, and optional reason; calls onSubmitted on success', async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockSubmit.mockResolvedValue({ result: 'OK', id: 'lr-1' });
    const onSubmitted = jest.fn();

    render(<LeaveRequestFormScreen onSubmitted={onSubmitted} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('leave-type-tile-WEEKLY_OFF'));
    fireEvent.changeText(screen.getByTestId('leave-window-start-input'), '2026-08-10');
    fireEvent.changeText(screen.getByTestId('leave-window-end-input'), '2026-08-12');
    fireEvent.changeText(screen.getByTestId('leave-reason-input'), 'Family event');

    fireEvent.press(screen.getByTestId('leave-submit'));

    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith('token', {
        seId: 'se-1',
        type: 'WEEKLY_OFF',
        windowStart: '2026-08-10',
        windowEnd: '2026-08-12',
        reason: 'Family event',
      }),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it('omits reason when left blank', async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockSubmit.mockResolvedValue({ result: 'OK', id: 'lr-1' });

    render(<LeaveRequestFormScreen onSubmitted={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('leave-type-tile-ON_LEAVE'));
    fireEvent.changeText(screen.getByTestId('leave-window-start-input'), '2026-08-10');
    fireEvent.changeText(screen.getByTestId('leave-window-end-input'), '2026-08-12');

    fireEvent.press(screen.getByTestId('leave-submit'));

    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith('token', {
        seId: 'se-1',
        type: 'ON_LEAVE',
        windowStart: '2026-08-10',
        windowEnd: '2026-08-12',
      }),
    );
  });

  it('renders an inline error on WINDOW_ORDER and does not call onSubmitted', async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockSubmit.mockRejectedValue(new Error('WINDOW_ORDER'));
    const onSubmitted = jest.fn();

    render(<LeaveRequestFormScreen onSubmitted={onSubmitted} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('leave-type-tile-ON_LEAVE'));
    fireEvent.changeText(screen.getByTestId('leave-window-start-input'), '2026-08-12');
    fireEvent.changeText(screen.getByTestId('leave-window-end-input'), '2026-08-10');

    fireEvent.press(screen.getByTestId('leave-submit'));

    await waitFor(() => expect(screen.getByTestId('leave-form-error')).toBeTruthy());
    expect(screen.getByText('WINDOW_ORDER')).toBeTruthy();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('calls onCancel when Back is pressed', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    const onCancel = jest.fn();

    render(<LeaveRequestFormScreen onSubmitted={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByTestId('leave-form-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
