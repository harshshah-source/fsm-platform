import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { AvailabilityRow } from '@fsm/shared';
import { AvailabilityScreen } from './AvailabilityScreen';
import { apiGetMyAvailability, apiSetAvailability } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiGetMyAvailability: jest.fn(), apiSetAvailability: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockGetMyAvailability = jest.mocked(apiGetMyAvailability);
const mockSetAvailability = jest.mocked(apiSetAvailability);
const mockGetAccessToken = jest.mocked(getAccessToken);

const NOW = Date.now();
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function row(overrides: Partial<AvailabilityRow> = {}): AvailabilityRow {
  return {
    status: 'AVAILABLE',
    windowStart: hoursFromNow(-1),
    windowEnd: null,
    reason: null,
    setByRole: null,
    ...overrides,
  };
}

describe('AvailabilityScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows AVAILABLE and a Go Unavailable action when no window is active', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyAvailability.mockResolvedValue({ items: [row()], cursor: null });

    render(<AvailabilityScreen seId="se-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Available')).toBeTruthy());
    expect(screen.getByTestId('availability-go-unavailable-button')).toBeTruthy();
    expect(screen.queryByTestId('availability-clear-button')).toBeNull();
  });

  it('shows the empty-list case as AVAILABLE too', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyAvailability.mockResolvedValue({ items: [], cursor: null });

    render(<AvailabilityScreen seId="se-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Available')).toBeTruthy());
  });

  it('shows SOFT_UNAVAILABLE with its window and a Clear action when self-set', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyAvailability.mockResolvedValue({
      items: [row({ status: 'SOFT_UNAVAILABLE', windowStart: hoursFromNow(-1), windowEnd: hoursFromNow(5), setByRole: 'SERVICE_ENGINEER' })],
      cursor: null,
    });

    render(<AvailabilityScreen seId="se-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Soft Unavailable')).toBeTruthy());
    expect(screen.getByTestId('availability-clear-button')).toBeTruthy();
    expect(screen.queryByTestId('availability-go-unavailable-button')).toBeNull();
  });

  it('shows a manager-set status (e.g. ON_LEAVE) as read-only, no Clear action', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyAvailability.mockResolvedValue({
      items: [row({ status: 'ON_LEAVE', windowStart: hoursFromNow(-1), windowEnd: hoursFromNow(48), setByRole: 'ZONAL_MANAGER' })],
      cursor: null,
    });

    render(<AvailabilityScreen seId="se-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('On Leave')).toBeTruthy());
    expect(screen.queryByTestId('availability-clear-button')).toBeNull();
    expect(screen.queryByTestId('availability-go-unavailable-button')).toBeNull();
  });

  it('sets SOFT_UNAVAILABLE with the entered window and refetches on success', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyAvailability.mockResolvedValue({ items: [row()], cursor: null });
    mockSetAvailability.mockResolvedValue({ result: 'OK', id: 'av-1' });

    render(<AvailabilityScreen seId="se-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('availability-go-unavailable-button')).toBeTruthy());
    fireEvent.press(screen.getByTestId('availability-go-unavailable-button'));

    fireEvent.changeText(screen.getByTestId('availability-window-start-input'), '2026-08-10T09:00:00Z');
    fireEvent.changeText(screen.getByTestId('availability-window-end-input'), '2026-08-10T17:00:00Z');
    fireEvent.press(screen.getByTestId('availability-set-submit'));

    await waitFor(() =>
      expect(mockSetAvailability).toHaveBeenCalledWith('token', 'se-1', {
        status: 'SOFT_UNAVAILABLE',
        windowStart: '2026-08-10T09:00:00Z',
        windowEnd: '2026-08-10T17:00:00Z',
      }),
    );
    await waitFor(() => expect(mockGetMyAvailability).toHaveBeenCalledTimes(2));
  });

  it('clears SOFT_UNAVAILABLE by self-setting AVAILABLE with the active window\'s own windowEnd', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    const activeEnd = hoursFromNow(5);
    mockGetMyAvailability.mockResolvedValue({
      items: [row({ status: 'SOFT_UNAVAILABLE', windowStart: hoursFromNow(-1), windowEnd: activeEnd })],
      cursor: null,
    });
    mockSetAvailability.mockResolvedValue({ result: 'OK', id: 'av-2' });

    render(<AvailabilityScreen seId="se-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('availability-clear-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('availability-clear-button'));

    await waitFor(() =>
      expect(mockSetAvailability).toHaveBeenCalledWith(
        'token',
        'se-1',
        expect.objectContaining({ status: 'AVAILABLE', windowEnd: activeEnd }),
      ),
    );
    await waitFor(() => expect(mockGetMyAvailability).toHaveBeenCalledTimes(2));
  });

  it('renders an inline error when the server rejects the clear (AVAILABILITY_FORBIDDEN)', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyAvailability.mockResolvedValue({
      items: [row({ status: 'SOFT_UNAVAILABLE', windowStart: hoursFromNow(-1), windowEnd: hoursFromNow(5) })],
      cursor: null,
    });
    mockSetAvailability.mockRejectedValue(new Error('AVAILABILITY_FORBIDDEN'));

    render(<AvailabilityScreen seId="se-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('availability-clear-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('availability-clear-button'));

    await waitFor(() => expect(screen.getByTestId('availability-form-error')).toBeTruthy());
    expect(screen.getByText('AVAILABILITY_FORBIDDEN')).toBeTruthy();
  });

  it('calls onBack when the back button is pressed', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetMyAvailability.mockResolvedValue({ items: [row()], cursor: null });
    const onBack = jest.fn();

    render(<AvailabilityScreen seId="se-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('availability-back')).toBeTruthy());

    fireEvent.press(screen.getByTestId('availability-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
