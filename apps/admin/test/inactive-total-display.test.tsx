import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CompanyPlantRow, ZoneOverviewRow } from '../src/api/dashboard';
import { ScorecardTable } from '../src/pages/dashboard/ScorecardTable';
import { ZoneOverviewTable } from '../src/pages/dashboard/ZoneOverviewTable';
import { CompanyPlantTable } from '../src/pages/dashboard/CompanyPlantTable';

/** Issue 2 — every inactive-device count renders its `inactive / total` denominator. */
const zone: ZoneOverviewRow = {
  zoneId: '1', zoneName: 'NORTH', totalInactive: 3, totalDevices: 10,
  byBucket: { CRITICAL: 3 }, trendPctVsPrevDay: null,
};
const plant: CompanyPlantRow = {
  companyId: '9', companyName: 'Acme', companyTier: 'GOLD', zoneId: '1',
  plantId: '5', plantName: 'Yard-1', totalInactive: 2, totalDevices: 40, byBucket: { CRITICAL: 2 },
};

describe('Issue 2 — inactive / total presentation', () => {
  it('Scorecard shows inactive / total per zone', () => {
    render(
      <MemoryRouter>
        <ScorecardTable rows={[zone]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('scorecard-inactive-total')).toHaveTextContent('3 / 10');
  });

  it('Zone Overview shows inactive / total per zone', () => {
    render(
      <MemoryRouter>
        <ZoneOverviewTable rows={[zone]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('zone-inactive-total')).toHaveTextContent('3 / 10');
  });

  it('Company/Plant shows inactive / total per plant (after expanding the company)', async () => {
    render(
      <MemoryRouter>
        <CompanyPlantTable rows={[plant]} />
      </MemoryRouter>,
    );
    // Collapsed by default (Issue 122) — expand the company to reveal its plant rows.
    await userEvent.click(screen.getByText('Acme'));
    expect(within(screen.getByTestId('plant-inactive-total')).getByText('2 / 40')).toBeInTheDocument();
  });
});
