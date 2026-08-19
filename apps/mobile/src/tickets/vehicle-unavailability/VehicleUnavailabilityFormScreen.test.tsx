import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { SessionView } from '@fsm/shared';
import { VehicleUnavailabilityFormScreen } from './VehicleUnavailabilityFormScreen';
import { apiFileVehicleUnavailability } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { getAccessToken } from '../../auth/tokenStore';
import { captureLocation } from '../detail/captureLocation';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiFileVehicleUnavailability: jest.fn() };
});
jest.mock('../../auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../detail/captureLocation', () => ({ captureLocation: jest.fn() }));

const mockFile = jest.mocked(apiFileVehicleUnavailability);
const mockUseAuth = jest.mocked(useAuth);
const mockGetAccessToken = jest.mocked(getAccessToken);
const mockCaptureLocation = jest.mocked(captureLocation);

const session: SessionView = { user_id: 'se-1', role: 'SERVICE_ENGINEER', zone_id: 3, acted_as_role: null };

function renderForm(overrides: Partial<Parameters<typeof VehicleUnavailabilityFormScreen>[0]> = {}) {
  const props = {
    ticketId: 't-1',
    transporterName: null as string | null,
    transporterContact: null as string | null,
    onSubmitted: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  render(<VehicleUnavailabilityFormScreen {...props} />);
  return props;
}

describe('VehicleUnavailabilityFormScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the reason tiles and prefills the transporter fields from Ticket Detail', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    renderForm({ transporterName: 'Rapid Fleet', transporterContact: '+91-9000000000' });

    expect(screen.getByTestId('vu-reason-tile-VEHICLE_ON_TRIP')).toBeTruthy();
    expect(screen.getByDisplayValue('Rapid Fleet')).toBeTruthy();
    expect(screen.getByDisplayValue('+91-9000000000')).toBeTruthy();
  });

  it('disables submit until a reason and a valid return date are entered', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    renderForm();

    expect(screen.getByTestId('vu-submit').props.accessibilityState?.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('vu-reason-tile-VEHICLE_ON_TRIP'));
    expect(screen.getByTestId('vu-submit').props.accessibilityState?.disabled).toBe(true);

    // A half-typed date must not arm the button — the server would 400 and the SE would lose the form.
    fireEvent.changeText(screen.getByTestId('vu-expected-date'), '2026-06');
    expect(screen.getByTestId('vu-submit').props.accessibilityState?.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('vu-expected-date'), '2026-06-27');
    expect(screen.getByTestId('vu-submit').props.accessibilityState?.disabled).toBe(false);
  });

  // #246 — the whole point of replacing the preset ladder: it capped at ~tomorrow 2 PM.
  it('accepts a return date months out, sent as an IST instant', async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockFile.mockResolvedValue({ result: 'OK', id: 'vu-1', deferredUntil: '2026-08-25T00:00:00.000Z' });
    renderForm();

    fireEvent.press(screen.getByTestId('vu-reason-tile-VEHICLE_ON_TRIP'));
    fireEvent.changeText(screen.getByTestId('vu-expected-date'), '2026-08-25');
    fireEvent.press(screen.getByTestId('vu-submit'));

    await waitFor(() => expect(mockFile).toHaveBeenCalledTimes(1));
    expect(mockFile).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ ticketId: 't-1', seId: 'se-1', expectedFrom: '2026-08-24T18:30:00.000Z' }),
    );
  });

  it("submits with seId = the caller's own id, never rendering a Secondary SLA Clock field", async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockFile.mockResolvedValue({ result: 'OK', id: 'vu-1', deferredUntil: null });
    renderForm({ transporterName: 'Rapid Fleet', transporterContact: '+91-9000000000' });

    fireEvent.press(screen.getByTestId('vu-reason-tile-VEHICLE_NOT_AT_PLANT'));
    fireEvent.press(screen.getByTestId('vu-transporter-contacted-toggle'));
    fireEvent.changeText(screen.getByTestId('vu-expected-date'), '2026-06-25');
    fireEvent.press(screen.getByTestId('vu-submit'));

    await waitFor(() => expect(mockFile).toHaveBeenCalledTimes(1));
    expect(mockFile).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        ticketId: 't-1',
        seId: 'se-1',
        reasonCode: 'VEHICLE_NOT_AT_PLANT',
        transporterContacted: true,
        transporterName: 'Rapid Fleet',
        transporterContact: '+91-9000000000',
      }),
    );
    expect(screen.queryByText(/secondary sla/i)).toBeNull();
  });

  // AC6 — the SE is told what filing actually did, using the server's own answer rather than the
  // date they typed. Those differ whenever the same-day rule applies.
  it('confirms the return day the server decided on, and only then leaves the form', async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockFile.mockResolvedValue({ result: 'OK', id: 'vu-1', deferredUntil: '2026-06-27T00:00:00.000Z' });
    const props = renderForm();

    fireEvent.press(screen.getByTestId('vu-reason-tile-VEHICLE_ON_TRIP'));
    fireEvent.changeText(screen.getByTestId('vu-expected-date'), '2026-06-27');
    fireEvent.press(screen.getByTestId('vu-submit'));

    const confirmation = await screen.findByTestId('vu-confirmation');
    expect(confirmation).toBeTruthy();
    expect(screen.getByText(/return to scheduling on 27 Jun 2026/i)).toBeTruthy();
    // The screen stays put until the SE acknowledges — closing straight back to Ticket Detail is how
    // the old flow made the return date unreadable.
    expect(props.onSubmitted).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('vu-confirmation-done'));
    expect(props.onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('says the ticket stays on today\'s list when the server derived no wait', async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockFile.mockResolvedValue({ result: 'OK', id: 'vu-1', deferredUntil: null });
    renderForm();

    fireEvent.press(screen.getByTestId('vu-reason-tile-VEHICLE_ON_TRIP'));
    fireEvent.changeText(screen.getByTestId('vu-expected-date'), '2026-06-25');
    fireEvent.press(screen.getByTestId('vu-submit'));

    await screen.findByTestId('vu-confirmation');
    expect(screen.getByText(/stays available today/i)).toBeTruthy();
    expect(screen.queryByText(/return to scheduling on/i)).toBeNull();
  });

  it('calls onCancel when Back is pressed', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    const props = renderForm();

    fireEvent.press(screen.getByTestId('vu-form-cancel'));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});
