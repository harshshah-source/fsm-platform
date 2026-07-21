import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CompanyPlantRow, ZoneOverviewRow } from '../src/api/dashboard';
import { ScorecardTable } from '../src/pages/dashboard/ScorecardTable';
import { ZoneOverviewTable } from '../src/pages/dashboard/ZoneOverviewTable';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';

/**
 * The inactive-device count in every overview table is a click-through into the Device Detail list,
 * pre-filtered to exactly those inactive devices (`status=INACTIVE` + the entity id). Asserts the href
 * carries the right scope at each level (zone / company / plant).
 */
const zone: ZoneOverviewRow = {
  zoneId: '1', zoneName: 'NORTH', totalInactive: 3, totalDevices: 10,
  byBucket: { CRITICAL: 3 }, trendPctVsPrevDay: null,
};
const plant: CompanyPlantRow = {
  companyId: '9', companyName: 'Acme', companyTier: 'GOLD', zoneId: '1',
  plantId: '5', plantName: 'Yard-1', totalInactive: 2, totalDevices: 40, byBucket: { CRITICAL: 2 },
};
const zeroZone: ZoneOverviewRow = { ...zone, zoneId: '2', zoneName: 'SOUTH', totalInactive: 0 };

const inRouter = (ui: JSX.Element) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('Inactive count deep-link into the filtered Device Detail list', () => {
  it('Zone Overview count links to that zone, filtered to INACTIVE', () => {
    inRouter(<ZoneOverviewTable rows={[zone]} />);
    const link = within(screen.getByTestId('zone-inactive-total')).getByRole('link', { name: '3 / 10' });
    expect(link).toHaveAttribute('href', expect.stringContaining('/reports/device?'));
    expect(link.getAttribute('href')).toContain('zoneId=1');
    expect(link.getAttribute('href')).toContain('status=INACTIVE');
  });

  it('Scorecard count links to that zone, filtered to INACTIVE', () => {
    inRouter(<ScorecardTable rows={[zone]} />);
    const link = within(screen.getByTestId('scorecard-inactive-total')).getByRole('link', { name: '3 / 10' });
    expect(link.getAttribute('href')).toContain('zoneId=1');
    expect(link.getAttribute('href')).toContain('status=INACTIVE');
  });

  it('Company/Plant links the company count by companyId and the plant count by plantId', async () => {
    inRouter(<CompanyPlantTable rows={[plant]} />);
    const companyRow = screen.getByText('Acme').closest('tr')!;
    const companyLink = within(companyRow).getByRole('link', { name: '2 / 40' });
    expect(companyLink.getAttribute('href')).toContain('companyId=9');
    expect(companyLink.getAttribute('href')).toContain('status=INACTIVE');

    await userEvent.click(screen.getByText('Acme')); // expand → plant sub-table
    const plantLink = within(screen.getByTestId('plant-inactive-total')).getByRole('link', { name: '2 / 40' });
    expect(plantLink.getAttribute('href')).toContain('plantId=5');
    expect(plantLink.getAttribute('href')).toContain('status=INACTIVE');
  });

  it('Company/Plant SLA-bucket counts deep-link to that entity + bucket, filtered to INACTIVE', async () => {
    inRouter(<CompanyPlantTable rows={[plant]} />);

    // Company aggregate row: the CRITICAL (24–48Hr) bucket count (2) links by companyId + bucket.
    const companyRow = screen.getByText('Acme').closest('tr')!;
    const companyBucketLink = within(within(companyRow).getByTestId('bucket-CRITICAL')).getByRole('link');
    expect(companyBucketLink.getAttribute('href')).toContain('companyId=9');
    expect(companyBucketLink.getAttribute('href')).toContain('bucket=CRITICAL');
    expect(companyBucketLink.getAttribute('href')).toContain('status=INACTIVE');

    await userEvent.click(screen.getByText('Acme')); // expand → plant sub-table
    const plantRow = screen.getByText('Yard-1').closest('tr')!;
    const plantBucketLink = within(within(plantRow).getByTestId('bucket-CRITICAL')).getByRole('link');
    expect(plantBucketLink.getAttribute('href')).toContain('plantId=5');
    expect(plantBucketLink.getAttribute('href')).toContain('bucket=CRITICAL');
    expect(plantBucketLink.getAttribute('href')).toContain('status=INACTIVE');

    // A zero bucket (e.g. WARNING here) is a muted dash, not a link.
    expect(within(within(plantRow).getByTestId('bucket-WARNING')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a zero inactive count as plain text, not a link', () => {
    inRouter(<ZoneOverviewTable rows={[zeroZone]} />);
    const cell = screen.getByTestId('zone-inactive-total');
    expect(within(cell).queryByRole('link')).not.toBeInTheDocument();
    expect(cell).toHaveTextContent('0 / 10');
  });
});
