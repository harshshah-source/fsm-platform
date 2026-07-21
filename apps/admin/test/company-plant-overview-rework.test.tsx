import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyPlantRow } from '../src/api/dashboard';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';

// The plant-row drill-down loads open tickets — stub the client so a plant click is deterministic.
const listMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('../src/api/tickets', () => ({
  apiTicketsList: (...args: unknown[]) => listMock(...args),
}));

const plantA: CompanyPlantRow = {
  companyId: '9', companyName: 'Acme', companyTier: 'GOLD', zoneId: '1',
  plantId: '5', plantName: 'Yard-1', totalInactive: 2, totalDevices: 40, byBucket: { CRITICAL: 2 },
};
const plantB: CompanyPlantRow = {
  companyId: '9', companyName: 'Acme', companyTier: 'GOLD', zoneId: '1',
  plantId: '6', plantName: 'Yard-2', totalInactive: 1, totalDevices: 10, byBucket: { WARNING: 1 },
};

function renderTable(uptime?: Map<string, number>) {
  return render(
    <MemoryRouter>
      <CompanyPlantTable rows={[plantA, plantB]} plantUptime={uptime} />
    </MemoryRouter>,
  );
}

describe('Issue 135 — Company/Plant Overview rework', () => {
  beforeEach(() => listMock.mockClear());

  it('renders Tier and Plants as their own columns (not just inline badges)', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: /tier/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /plants/i })).toBeInTheDocument();
    // The company aggregate row shows the tier chip and the plant count (2 plants) in those columns.
    // Columns: 0 Company · 1 Tier · 2 Plants · 3 Plant · 4 Inactive/Total · 5 SLA · 6 Fleet Uptime.
    const companyRow = screen.getByText('Acme').closest('tr')!;
    const cells = within(companyRow).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('GOLD');
    expect(cells[2]).toHaveTextContent('2');
  });

  it('has a Fleet Uptime % column and no standalone Devices column', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: /fleet uptime/i })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^devices$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /view devices/i })).not.toBeInTheDocument();
  });

  it('shows the per-plant fleet uptime, and — when a plant has no computed value', async () => {
    renderTable(new Map([['5', 98.2]])); // only Yard-1 has a value
    await userEvent.click(screen.getByText('Acme')); // expand the company
    const yard1 = screen.getByText('Yard-1').closest('tr')!;
    const yard2 = screen.getByText('Yard-2').closest('tr')!;
    expect(within(yard1).getByTestId('plant-fleet-uptime')).toHaveTextContent('98.2%');
    expect(within(yard2).getByTestId('plant-fleet-uptime')).toHaveTextContent('—');
  });

  it('clicking a plant row opens its device sub-table (no View-devices button needed)', async () => {
    renderTable();
    await userEvent.click(screen.getByText('Acme')); // expand company → plants visible
    const yard1 = screen.getByText('Yard-1').closest('tr')!;
    await userEvent.click(yard1);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ plantId: '5' }));
    expect(yard1).toHaveAttribute('aria-expanded', 'true');
  });
});
