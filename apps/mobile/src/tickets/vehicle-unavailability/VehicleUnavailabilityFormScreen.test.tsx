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

describe('VehicleUnavailabilityFormScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the reason tiles and prefills the transporter fields from Ticket Detail', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    render(
      <VehicleUnavailabilityFormScreen
        ticketId="t-1"
        transporterName="Rapid Fleet"
        transporterContact="+91-9000000000"
        onSubmitted={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByTestId('vu-reason-tile-VEHICLE_ON_TRIP')).toBeTruthy();
    expect(screen.getByDisplayValue('Rapid Fleet')).toBeTruthy();
    expect(screen.getByDisplayValue('+91-9000000000')).toBeTruthy();
  });

  it('disables submit until a reason and an expected-back option are chosen', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    render(
      <VehicleUnavailabilityFormScreen
        ticketId="t-1"
        transporterName={null}
        transporterContact={null}
        onSubmitted={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByTestId('vu-submit').props.accessibilityState?.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('vu-reason-tile-VEHICLE_ON_TRIP'));
    expect(screen.getByTestId('vu-submit').props.accessibilityState?.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('vu-expected-from-tile-4h'));
    expect(screen.getByTestId('vu-submit').props.accessibilityState?.disabled).toBe(false);
  });

  it('submits with seId = the caller\'s own id, never rendering a Secondary SLA Clock field', async () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockFile.mockResolvedValue({ result: 'OK', id: 'vu-1' });
    const onSubmitted = jest.fn();

    render(
      <VehicleUnavailabilityFormScreen
        ticketId="t-1"
        transporterName="Rapid Fleet"
        transporterContact="+91-9000000000"
        onSubmitted={onSubmitted}
        onCancel={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByTestId('vu-reason-tile-VEHICLE_NOT_AT_PLANT'));
    fireEvent.press(screen.getByTestId('vu-transporter-contacted-toggle'));
    fireEvent.press(screen.getByTestId('vu-expected-from-tile-2h'));
    fireEvent.press(screen.getByTestId('vu-submit'));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
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

  it('calls onCancel when Back is pressed', () => {
    mockUseAuth.mockReturnValue({ session, isLoading: false } as never);
    const onCancel = jest.fn();
    render(
      <VehicleUnavailabilityFormScreen
        ticketId="t-1"
        transporterName={null}
        transporterContact={null}
        onSubmitted={jest.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.press(screen.getByTestId('vu-form-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
