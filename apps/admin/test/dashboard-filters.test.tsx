import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyPlantRow, ZoneOverviewRow } from '../src/api/dashboard';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';
import { ZoneOverviewTable } from '../src/pages/dashboard/ZoneOverviewTable';

/**
 * Issue 06 slice 8 — the overview filters (AC#2/#3 "filter ... work"). Client-side filtering of the
 * already-scoped rows: Zone Overview by zone and by bucket; Company/Plant by company. Row assertions
 * are scoped to the table so the filter <option> labels (which echo the same names) don't collide.
 */
const zoneRows: ZoneOverviewRow[] = [
  { zoneId: '1', zoneName: 'NORTH', totalInactive: 3, byBucket: { CRITICAL: 3 }, trendPctVsPrevDay: null },
  { zoneId: '2', zoneName: 'SOUTH', totalInactive: 2, byBucket: { WARNING: 2 }, trendPctVsPrevDay: null },
];

const cpRows: CompanyPlantRow[] = [
  { companyId: '1', companyName: 'Acme', companyTier: 'PLATINUM', zoneId: '1', plantId: '7', plantName: 'Yard-1', totalInactive: 1, byBucket: { CRITICAL: 1 } },
  { companyId: '2', companyName: 'Globex', companyTier: 'SILVER', zoneId: '1', plantId: '8', plantName: 'Yard-2', totalInactive: 1, byBucket: { WARNING: 1 } },
];

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Dashboard filters (Issue 06 AC#2/#3)', () => {
  it('filters Zone Overview by zone', async () => {
    render(<ZoneOverviewTable rows={zoneRows} />);
    const table = () => within(screen.getByRole('table', { name: /zone overview/i }));
    expect(table().getByText('NORTH')).toBeInTheDocument();
    expect(table().getByText('SOUTH')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/filter by zone/i), 'SOUTH');
    expect(table().queryByText('NORTH')).not.toBeInTheDocument();
    expect(table().getByText('SOUTH')).toBeInTheDocument();
  });

  it('filters Zone Overview by bucket', async () => {
    render(<ZoneOverviewTable rows={zoneRows} />);
    const table = () => within(screen.getByRole('table', { name: /zone overview/i }));
    await userEvent.selectOptions(screen.getByLabelText(/filter by bucket/i), 'WARNING');
    expect(table().queryByText('NORTH')).not.toBeInTheDocument();
    expect(table().getByText('SOUTH')).toBeInTheDocument();
  });

  it('filters Company/Plant Overview by company', async () => {
    render(<CompanyPlantTable rows={cpRows} />);
    const table = () => within(screen.getByRole('table', { name: /company\/plant overview/i }));
    expect(table().getByText('Acme')).toBeInTheDocument();
    expect(table().getByText('Globex')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/filter by company/i), 'Globex');
    expect(table().queryByText('Acme')).not.toBeInTheDocument();
    expect(table().getByText('Globex')).toBeInTheDocument();
  });
});
