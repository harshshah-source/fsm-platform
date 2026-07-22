import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyPlantRow, ZoneOverviewRow } from '../src/api/dashboard';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';
import { ZoneOverviewTable } from '../src/pages/dashboard/ZoneOverviewTable';

// The overview tables now deep-link their inactive counts into the Device Detail list, so each render
// needs a Router in scope for the <Link>s (same requirement the Scorecard table already carries).
const inRouter = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

/**
 * Issue 06 slice 8 — the overview filters (AC#2/#3 "filter ... work"). Client-side filtering of the
 * already-scoped rows: Zone Overview by zone and by bucket; Company/Plant by company. Row assertions
 * are scoped to the table so the filter <option> labels (which echo the same names) don't collide.
 */
const zoneRows: ZoneOverviewRow[] = [
  { zoneId: '1', zoneName: 'NORTH', totalInactive: 3, totalDevices: 10, byBucket: { CRITICAL: 3 }, trendPctVsPrevDay: null },
  { zoneId: '2', zoneName: 'SOUTH', totalInactive: 2, totalDevices: 8, byBucket: { WARNING: 2 }, trendPctVsPrevDay: null },
];

const cpRows: CompanyPlantRow[] = [
  { companyId: '1', companyName: 'Acme', companyTier: 'PLATINUM', zoneId: '1', plantId: '7', plantName: 'Yard-1', totalInactive: 1, totalDevices: 20, byBucket: { CRITICAL: 1 } },
  { companyId: '2', companyName: 'Globex', companyTier: 'SILVER', zoneId: '1', plantId: '8', plantName: 'Yard-2', totalInactive: 1, totalDevices: 15, byBucket: { WARNING: 1 } },
];

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Dashboard filters (Issue 06 AC#2/#3)', () => {
  it('filters Zone Overview by zone', async () => {
    inRouter(<ZoneOverviewTable rows={zoneRows} />);
    const table = () => within(screen.getByRole('table', { name: /zone overview/i }));
    expect(table().getByText('NORTH')).toBeInTheDocument();
    expect(table().getByText('SOUTH')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/filter by zone/i), 'SOUTH');
    expect(table().queryByText('NORTH')).not.toBeInTheDocument();
    expect(table().getByText('SOUTH')).toBeInTheDocument();
  });

  it('filters Zone Overview by bucket', async () => {
    inRouter(<ZoneOverviewTable rows={zoneRows} />);
    const table = () => within(screen.getByRole('table', { name: /zone overview/i }));
    await userEvent.selectOptions(screen.getByLabelText(/filter by bucket/i), 'WARNING');
    expect(table().queryByText('NORTH')).not.toBeInTheDocument();
    expect(table().getByText('SOUTH')).toBeInTheDocument();
  });

  it('filters Company/Plant Overview by the universal search (Issue 122)', async () => {
    inRouter(<CompanyPlantTable rows={cpRows} />);
    const table = () => within(screen.getByRole('table', { name: /company\/plant overview/i }));
    expect(table().getByText('Acme')).toBeInTheDocument();
    expect(table().getByText('Globex')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/search company, plant or id/i), 'Globex');
    expect(table().queryByText('Acme')).not.toBeInTheDocument();
    // Matched company auto-expands; "Globex" now shows on its company row and its plant row (Issue 135).
    expect(table().getAllByText('Globex').length).toBeGreaterThan(0);
  });
});
