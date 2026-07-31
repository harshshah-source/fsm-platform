import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyPlantRow, ZoneOverviewRow } from '../src/api/dashboard';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';
import { ZoneOverviewTable } from '../src/pages/dashboard/ZoneOverviewTable';
import { companyPlantRow, zoneRow } from './fixtures/fleet';

// The overview tables now deep-link their inactive counts into the Device Detail list, so each render
// needs a Router in scope for the <Link>s (same requirement the Scorecard table already carries).
const inRouter = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

/**
 * Issue 06 slice 8 — the overview filters (AC#2/#3 "filter ... work"). Client-side filtering of the
 * already-scoped rows: Zone Overview by zone and by bucket; Company/Plant by company. Row assertions
 * are scoped to the table so the filter <option> labels (which echo the same names) don't collide.
 */
const zoneRows: ZoneOverviewRow[] = [
  zoneRow({ zoneId: '1', zoneName: 'NORTH', operational: 10, inactive: 3, byBucket: { CRITICAL: 3 } }),
  zoneRow({ zoneId: '2', zoneName: 'SOUTH', operational: 8, inactive: 2, byBucket: { WARNING: 2 } }),
];

const cpRows: CompanyPlantRow[] = [
  companyPlantRow({ companyId: '1', companyName: 'Acme', companyTier: 'PLATINUM', plantId: '7', plantName: 'Yard-1', operational: 20, inactive: 1, byBucket: { CRITICAL: 1 } }),
  companyPlantRow({ companyId: '2', companyName: 'Globex', companyTier: 'SILVER', plantId: '8', plantName: 'Yard-2', operational: 15, inactive: 1, byBucket: { WARNING: 1 } }),
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
