import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityTrendSection } from '../src/pages/dashboard/ActivityTrendSection';

// Stub the trend client so the section's fetch is deterministic and its args are inspectable.
const trendMock = vi.fn(async (..._args: unknown[]) => ({
  range: '7D',
  from: '',
  to: '',
  bucket: 'day' as const,
  zoneId: null,
  points: [{ bucket: '2026-07-19 00:00:00', inactive: 5, troubleshoot: 2, installation: 1 }],
}));
vi.mock('../src/api/dashboard', () => ({
  apiActivityTrend: (...args: unknown[]) => trendMock(...args),
}));

const zones = [
  { zoneId: '1', zoneName: 'NORTH' },
  { zoneId: '2', zoneName: 'SOUTH' },
];

describe('Issue 134 — Fleet Activity Trend section', () => {
  beforeEach(() => trendMock.mockClear());

  it('renders the chart and re-queries when the range changes (OH pan-India by default)', async () => {
    render(<ActivityTrendSection zones={zones} canSelectZone />);
    // Chart appears once the initial 7D pan-India load resolves.
    expect(await screen.findByTestId('activity-trend-chart')).toBeInTheDocument();
    expect(trendMock).toHaveBeenLastCalledWith({ range: '7D', zoneId: undefined });

    await userEvent.click(screen.getByRole('button', { name: '1D' }));
    await waitFor(() => expect(trendMock).toHaveBeenLastCalledWith({ range: '1D', zoneId: undefined }));
  });

  it('scopes the request to a chosen zone in Zone-wise view (OH zone dropdown)', async () => {
    render(<ActivityTrendSection zones={zones} canSelectZone />);
    await screen.findByTestId('activity-trend-chart');

    await userEvent.click(screen.getByRole('button', { name: 'Zone-wise' }));
    // Defaults to the first zone, then follows the dropdown selection.
    await waitFor(() => expect(trendMock).toHaveBeenLastCalledWith({ range: '7D', zoneId: '1' }));
    await userEvent.selectOptions(screen.getByLabelText(/select zone/i), '2');
    await waitFor(() => expect(trendMock).toHaveBeenLastCalledWith({ range: '7D', zoneId: '2' }));
  });

  it('hides the zone controls for a ZM and always requests their own zone (no zoneId)', async () => {
    render(<ActivityTrendSection zones={zones} canSelectZone={false} />);
    await screen.findByTestId('activity-trend-chart');
    expect(screen.queryByRole('button', { name: 'Zone-wise' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/select zone/i)).not.toBeInTheDocument();
    expect(trendMock).toHaveBeenLastCalledWith({ range: '7D', zoneId: undefined });
  });
});
