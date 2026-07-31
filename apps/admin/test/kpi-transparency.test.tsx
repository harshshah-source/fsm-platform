import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';
import { ScorecardTable } from '../src/pages/dashboard/ScorecardTable';
import { KPI_CATALOG } from '../src/lib/kpiCatalog';
import { zoneRow } from './fixtures/fleet';

/**
 * KPI transparency (2026-07-29 rework) — the dashboard must name each number for exactly one business
 * concept, show what is in it, and reconcile every layer.
 *
 * The values below are the live pan-India figures the rework was specified against, so a regression
 * shows up as the real number a manager would see rather than as an abstract fixture mismatch.
 */
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const CATALOG = 50_270;
const MIRRORED = 23_238;
const OPERATIONAL = 17_415;
const WAREHOUSE = 5_823;
const INACTIVE = 3_476;
const HEALTHY = 13_939;

const ZONES = [
  { zoneId: '1', zoneName: 'North', operational: 3527, inactive: 400, warehouse: 1088 },
  { zoneId: '2', zoneName: 'South', operational: 2482, inactive: 874, warehouse: 1611 },
  { zoneId: '3', zoneName: 'East', operational: 6529, inactive: 810, warehouse: 1637 },
  { zoneId: '4', zoneName: 'West', operational: 2098, inactive: 347, warehouse: 363 },
  { zoneId: '5', zoneName: 'UNZONED', operational: 2779, inactive: 1045, warehouse: 1124 },
];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = [];
      if (url.includes('dashboard/zone-overview')) {
        body = ZONES.map((z) => zoneRow({ ...z, byBucket: { CRITICAL: z.inactive } }));
      } else if (url.includes('dashboard/fleet-summary')) {
        body = {
          companies: 30,
          plants: 215,
          mirroredDevices: MIRRORED,
          operationalDevices: OPERATIONAL,
          warehouseDevices: WAREHOUSE,
          inactiveOperational: INACTIVE,
          healthyOperational: HEALTHY,
          inactivePct: 20,
          fleetHealthPct: 80,
          catalogDevices: CATALOG,
          lastMasterSyncAt: '2026-07-29T05:49:04.756Z',
          lastSnapshotAt: '2026-07-29T06:02:02.248Z',
        };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const renderDashboard = () =>
  render(
    <AuthProvider initialSession={opsHead}>
      <MemoryRouter>
        <DashboardHome />
      </MemoryRouter>
    </AuthProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('KPI naming — explicit business names, no generic ones', () => {
  it('renames Total Devices to AutoPlant Catalog and shows its sync timestamp', async () => {
    stubFetch();
    renderDashboard();
    const card = await screen.findByTestId('kpi-total-devices');
    expect(within(card).getByText('AutoPlant Catalog')).toBeInTheDocument();
    // The generic name it replaced must be gone — it invited comparison against the FSM counts.
    expect(within(card).queryByText('Total Devices')).not.toBeInTheDocument();
    expect(screen.getByTestId('kpi-catalog-sync')).toHaveTextContent(/Last sync:/);
  });

  it('renames Active Fleet to Operational Fleet', async () => {
    stubFetch();
    renderDashboard();
    const card = await screen.findByTestId('kpi-devices');
    expect(within(card).getByText('Operational Fleet')).toBeInTheDocument();
    expect(within(card).queryByText('Active Fleet')).not.toBeInTheDocument();
  });

  it('names the inactive KPI for the population it counts', async () => {
    stubFetch();
    renderDashboard();
    const card = await screen.findByTestId('kpi-inactive-operational-hero');
    expect(within(card).getByText('Inactive Operational Devices')).toBeInTheDocument();
  });
});

describe('Operational Fleet section — six KPIs over one population', () => {
  it('renders every operational KPI with the operational figures', async () => {
    stubFetch();
    renderDashboard();
    expect(await screen.findByTestId('kpi-operational-devices')).toHaveTextContent('17,415');
    expect(screen.getByTestId('kpi-healthy-devices')).toHaveTextContent('13,939');
    expect(screen.getByTestId('kpi-inactive-operational')).toHaveTextContent('3,476');
    expect(screen.getByTestId('kpi-warehouse-devices')).toHaveTextContent('5,823');
  });

  it('reconciles: healthy + inactive = operational, and the rates sum to 100%', async () => {
    stubFetch();
    renderDashboard();
    await screen.findByTestId('kpi-operational-devices');
    expect(HEALTHY + INACTIVE).toBe(OPERATIONAL);
    expect(OPERATIONAL + WAREHOUSE).toBe(MIRRORED);
    expect(screen.getByTestId('kpi-fleet-health-pct')).toHaveTextContent('80.0%');
    expect(screen.getByTestId('kpi-inactive-pct')).toHaveTextContent('20.0%');
  });

  it('states how fresh the counts are', async () => {
    stubFetch();
    renderDashboard();
    expect(await screen.findByTestId('operational-fleet-freshness')).toHaveTextContent(/Last snapshot:/);
  });
});

describe('Dashboard hierarchy — company → zone → KPI', () => {
  it('the zone column totals equal the Operational Fleet KPI cards', async () => {
    stubFetch();
    renderDashboard();
    await screen.findByTestId('kpi-operational-devices');
    const sum = (pick: (z: (typeof ZONES)[number]) => number) => ZONES.reduce((s, z) => s + pick(z), 0);
    expect(sum((z) => z.operational)).toBe(OPERATIONAL);
    expect(sum((z) => z.inactive)).toBe(INACTIVE);
    expect(sum((z) => z.warehouse)).toBe(WAREHOUSE);
    expect(sum((z) => z.operational - z.inactive)).toBe(HEALTHY);
  });

  it('the scorecard divides by the operational fleet, not the mirrored total', () => {
    // South: 874 inactive of 2,482 operational (35.2%) — NOT of 4,093 mirrored (21.4%), the pre-fix
    // denominator that made the worst zone look like the middle of the pack.
    const south = zoneRow({ zoneId: '2', zoneName: 'South', operational: 2482, inactive: 874, warehouse: 1611 });
    render(
      <MemoryRouter>
        <ScorecardTable rows={[south]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('scorecard-inactive-total')).toHaveTextContent('874 / 2,482');
    expect(screen.getByTestId('scorecard-inactive-pct')).toHaveTextContent('35.2%');
    expect(screen.getByTestId('scorecard-operational')).toHaveTextContent('2,482');
    expect(screen.getByTestId('scorecard-warehouse')).toHaveTextContent('1,611');
    expect(screen.getByTestId('scorecard-healthy')).toHaveTextContent('1,608');
  });
});

describe('KPI tooltips — what is counted, what is excluded, source, formula', () => {
  it('opens a definition panel naming the exclusions and the formula', async () => {
    render(
      <MemoryRouter>
        <ScorecardTable rows={[zoneRow({ zoneId: '1', zoneName: 'North', operational: 100, inactive: 10 })]} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByTestId('kpi-info-operationalDevices'));
    const panel = screen.getByRole('tooltip');
    expect(panel).toHaveTextContent('Operational Devices');
    expect(panel).toHaveTextContent(/Devices currently deployed/i);
    expect(panel).toHaveTextContent(/Warehouse \/ departed devices/i);
    expect(panel).toHaveTextContent('device_states');
    expect(panel).toHaveTextContent('COUNT(device_states WHERE is_departed = false)');
  });

  it('labels a source metric as coming from another system', async () => {
    stubFetch();
    renderDashboard();
    await screen.findByTestId('kpi-total-devices');
    await userEvent.click(screen.getByTestId('kpi-info-autoplantCatalog'));
    const panel = screen.getByRole('tooltip');
    expect(panel).toHaveTextContent('Source metric (AutoPlant)');
    expect(panel).toHaveTextContent(/latest successful master sync/i);
    expect(panel).toHaveTextContent(/deployed, warehouse, retired/i);
  });

  it('every catalog entry is complete — no KPI ships a half-written definition', () => {
    for (const [key, def] of Object.entries(KPI_CATALOG)) {
      expect(def.key, `${key}: key must match its catalog slot`).toBe(key);
      for (const field of ['name', 'definition', 'counts', 'source', 'refresh', 'formula'] as const) {
        expect(def[field]?.length, `${key}.${field} must be a non-empty string`).toBeGreaterThan(0);
      }
      expect(def.excludes.length, `${key}.excludes must state what is left out`).toBeGreaterThan(0);
    }
  });

  it('no KPI keeps a generic name', () => {
    const banned = ['Total Devices', 'Active Fleet', 'Devices'];
    const offenders = Object.values(KPI_CATALOG).filter((d) => banned.includes(d.name));
    expect(offenders.map((d) => d.name)).toEqual([]);
  });
});
