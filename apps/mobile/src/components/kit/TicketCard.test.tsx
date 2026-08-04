import { describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { TicketCard } from './TicketCard';

const ticket = {
  vehicleNo: 'GJ05 LM 2201',
  plantName: 'JSW Cement - Surat Plant',
  gpsId: 'GPS401',
  transporterName: 'Western Cargo',
  issueDescription: 'No main power — check fuse',
  priorityLabel: 'High Critical',
  priorityStatus: 'critical' as const,
  statusLabel: 'New',
  statusStatus: 'info' as const,
};

describe('TicketCard', () => {
  it('renders the ticket identity and priority/status pills', () => {
    render(<TicketCard ticket={ticket} />);

    expect(screen.getByText('GJ05 LM 2201')).toBeTruthy();
    expect(screen.getByText('JSW Cement - Surat Plant')).toBeTruthy();
    expect(screen.getByText('High Critical')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('No main power — check fuse')).toBeTruthy();
  });

  it('fires onCall/onWhatsApp when their buttons are pressed', () => {
    const onCall = jest.fn();
    const onWhatsApp = jest.fn();
    render(<TicketCard ticket={ticket} onCall={onCall} onWhatsApp={onWhatsApp} />);

    fireEvent.press(screen.getByText('Call'));
    fireEvent.press(screen.getByText('WhatsApp'));

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('omits the Call/WhatsApp row entirely when no transporter contact handlers are given', () => {
    render(<TicketCard ticket={ticket} />);

    expect(screen.queryByText('Call')).toBeNull();
    expect(screen.queryByText('WhatsApp')).toBeNull();
  });

  it('#66 — renders the same-day-update badge when given, omits it otherwise', () => {
    const { rerender } = render(<TicketCard ticket={ticket} badge={{ label: 'Newly Added', status: 'info' }} />);
    expect(screen.getByText('Newly Added')).toBeTruthy();

    rerender(<TicketCard ticket={ticket} />);
    expect(screen.queryByText('Newly Added')).toBeNull();
  });
});
