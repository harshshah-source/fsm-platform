import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyPlantRow } from '../src/api/dashboard';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';

/**
 * Issue 06 slice 6 — Company/Plant Overview with company → plant → device drill-down (AC#3).
 * Companies group their plants; expanding a plant loads its devices from the ticket list. CSV export.
 */
const rows: CompanyPlantRow[] = [
  {
    companyId: '10',
    companyName: 'Acme Logistics',
    companyTier: 'PLATINUM',
    zoneId: '1',
    plantId: '7',
    plantName: 'Yard-1',
    totalInactive: 2,
    totalDevices: 25,
    byBucket: { CRITICAL: 2 },
  },
];

function stubTickets(deviceId: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.includes('/tickets')
        ? [{ ticketId: 't1', deviceId, slaBucket: 'CRITICAL', status: 'OPEN', plantId: '7' }]
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Company/Plant Overview (Issue 06 AC#3 / Issue 122)', () => {
  it('opens collapsed, expands a company to its plants, then drills a plant down to devices', async () => {
    stubTickets('5005');
    render(<CompanyPlantTable rows={rows} />);

    const table = within(screen.getByRole('table', { name: /company\/plant overview/i }));
    // Company is its own row and visible; the plant is hidden until the company is expanded.
    expect(table.getByText('Acme Logistics')).toBeInTheDocument();
    expect(table.getByText('PLATINUM')).toBeInTheDocument();
    expect(table.queryByText('Yard-1')).not.toBeInTheDocument();

    // Expand the company row → the plant appears in its own Plant column.
    await userEvent.click(table.getByText('Acme Logistics'));
    const plantRow = table.getByText('Yard-1').closest('tr')!;
    expect(within(plantRow).getByTestId('bucket-CRITICAL')).toHaveTextContent('2');

    // Drill the plant down to its open device tickets (the third level).
    await userEvent.click(within(plantRow).getByRole('button', { name: /devices/i }));
    expect(await screen.findByText(/5005/)).toBeInTheDocument();
  });

  it('offers a multi-format download and an assignment-state filter', () => {
    stubTickets('5005');
    render(<CompanyPlantTable rows={rows} />);
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/download format/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/assignment state/i)).toBeInTheDocument();
  });
});
