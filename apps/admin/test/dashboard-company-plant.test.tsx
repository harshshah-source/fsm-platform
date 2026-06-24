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

describe('Company/Plant Overview (Issue 06 AC#3)', () => {
  it('groups plants under their company with tier, and drills a plant down to devices', async () => {
    stubTickets('5005');
    render(<CompanyPlantTable rows={rows} />);

    // Company → plant levels are visible (scoped to the table; the company-filter <option> echoes
    // the same company name outside it).
    const table = within(screen.getByRole('table', { name: /company\/plant overview/i }));
    expect(table.getByText('Acme Logistics')).toBeInTheDocument();
    expect(table.getByText('PLATINUM')).toBeInTheDocument();
    const plantRow = table.getByText('Yard-1').closest('tr')!;
    expect(within(plantRow).getByTestId('bucket-CRITICAL')).toHaveTextContent('2');

    // Drill the plant down to its devices (the third level).
    await userEvent.click(within(plantRow).getByRole('button', { name: /devices/i }));
    expect(await screen.findByText(/5005/)).toBeInTheDocument();
  });

  it('offers a CSV export', () => {
    stubTickets('5005');
    render(<CompanyPlantTable rows={rows} />);
    expect(
      screen.getByRole('button', { name: /export company\/plant overview/i }),
    ).toBeInTheDocument();
  });
});
