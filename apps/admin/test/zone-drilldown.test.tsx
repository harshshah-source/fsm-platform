import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DeviceDetailPage } from '../src/pages/reports/DeviceDetailPage';

/**
 * Zone drill-down on `/reports/device?zoneId=…&status=…` — the company → plant breakdown, KPI strip
 * and charts that sit above the device table when the page is entered from the Zone Performance
 * Scorecard.
 *
 * The load-bearing contracts under test:
 *  - every band is scoped by the URL's `zoneId` AND `status` (the requests carry both);
 *  - a zero row is kept and sorted last, never hidden — the "which plants are fine?" case;
 *  - an SLA column that cannot be non-zero (ACTIVE-only) IS dropped — that is a different call;
 *  - `UNZONED` / no zone renders an explanation rather than pan-India numbers under a zone heading;
 *  - the device table keeps working in every one of those states.
 */
const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const deviceRows = [
  {
    deviceId: '900', vehicleNo: 'RJ-14-AA', deviceType: 'AIS-140', imsiNo: '040492069489651',
    dealType: null, plantName: 'ACP-9106', zoneName: 'West', companyName: 'UltraTech',
    slaBucket: 'CRITICAL', latestGpsDatetime: '2026-06-01T00:00:00.000Z',
    tripCreationDatetime: '2026-07-13T08:36:27.000Z', isInactive: true,
    openTicketId: null, openTicketStatus: null, assignmentState: 'UNASSIGNED',
    assignedSeName: null, batchId: null, batchStatus: null, scheduleId: null,
  },
];

/** Two companies in the zone: one carrying all the inactivity, one completely healthy. */
const companyPlantRows = [
  {
    companyId: '7', companyName: 'UltraTech', companyTier: 'PLATINUM', zoneId: '3',
    plantId: '11', plantName: 'ACP-9106',
    mirroredDevices: 120, operationalDevices: 100, warehouseDevices: 20,
    inactiveOperational: 40, healthyOperational: 60, inactivePct: 40, fleetHealthPct: 60,
    byBucket: { CRITICAL: 25, LONG_PENDING: 15 },
  },
  {
    companyId: '9', companyName: 'Shree Cement', companyTier: 'GOLD', zoneId: '3',
    plantId: '12', plantName: 'SCP-2201',
    mirroredDevices: 50, operationalDevices: 50, warehouseDevices: 0,
    inactiveOperational: 0, healthyOperational: 50, inactivePct: 0, fleetHealthPct: 100,
    byBucket: {},
  },
];

const zoneOps = {
  openTickets: 30, assigned: 18, unassigned: 12,
  liveBatches: 4, overriddenBatches: 1, engineersEngaged: 3,
};

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();
/** Every URL the page requested, in order — the scoping assertions read this. */
let requested: string[] = [];

function stub() {
  requested = [];
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    requested.push(u);
    if (u.includes('/dashboard/company-plant-overview')) return json(companyPlantRows);
    if (u.includes('/dashboard/zone-operations')) return json(zoneOps);
    if (u.includes('/dashboard/fleet-summary'))
      return json({ companies: 2, plants: 2, mirroredDevices: 170, operationalDevices: 150, warehouseDevices: 20, inactiveOperational: 40, healthyOperational: 110, inactivePct: 26.7, fleetHealthPct: 73.3, catalogDevices: null, lastMasterSyncAt: null, lastSnapshotAt: '2026-08-04T06:00:00.000Z' });
    if (u.includes('/devices/filter-options'))
      return json({ zones: [{ zoneId: 3, name: 'West' }], companies: [{ companyId: 7, name: 'UltraTech' }], plants: [], hasUnzoned: true });
    if (u.includes('/tickets')) return json([]);
    if (u.includes('/devices')) return json({ rows: deviceRows, total: deviceRows.length });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderAt(search: string) {
  return render(
    <AuthProvider initialSession={OH}>
      <MemoryRouter initialEntries={[`/reports/device${search}`]}>
        <DeviceDetailPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const overviewCalls = () => requested.filter((u) => u.includes('company-plant-overview'));
const zoneOpsCalls = () => requested.filter((u) => u.includes('zone-operations'));

beforeEach(stub);
afterEach(() => vi.unstubAllGlobals());

describe('Zone drill-down — scoping', () => {
  it('scopes both aggregate reads to the zone AND the status from the URL', async () => {
    renderAt('?zoneId=3&status=INACTIVE');

    await waitFor(() => expect(overviewCalls().length).toBeGreaterThan(0));
    // The company/plant read is zone-filtered server-side — never fetched pan-India and trimmed here.
    expect(overviewCalls().every((u) => u.includes('zoneId=3'))).toBe(true);
    await waitFor(() => expect(zoneOpsCalls().length).toBeGreaterThan(0));
    expect(zoneOpsCalls().every((u) => u.includes('zoneId=3') && u.includes('status=INACTIVE'))).toBe(true);
  });

  it('re-queries the assignment band when the status filter changes', async () => {
    const { unmount } = renderAt('?zoneId=3&status=INACTIVE');
    await waitFor(() => expect(zoneOpsCalls().some((u) => u.includes('status=INACTIVE'))).toBe(true));
    unmount();

    stub();
    renderAt('?zoneId=3&status=ACTIVE');
    await waitFor(() => expect(zoneOpsCalls().length).toBeGreaterThan(0));
    // A KPI that ignored the active filter would be worse than no KPI, so the band refetches.
    expect(zoneOpsCalls().every((u) => u.includes('status=ACTIVE'))).toBe(true);
  });

  it('names the zone and the active status in the scope bar', async () => {
    renderAt('?zoneId=3&status=INACTIVE');
    const bar = await screen.findByTestId('zone-scope-bar');
    expect(within(bar).getByText('West')).toBeInTheDocument();
    expect(within(bar).getByText('Inactive devices only')).toBeInTheDocument();
  });
});

describe('Zone drill-down — KPIs', () => {
  it('leads with the filtered population and keeps the operational denominator visible', async () => {
    renderAt('?zoneId=3&status=INACTIVE');

    const inactive = await screen.findByTestId('zone-kpi-inactive');
    // 40 + 0 across the two companies, over 100 + 50 operational.
    expect(within(inactive).getByText('40')).toBeInTheDocument();
    expect(within(inactive).getByText(/of 150 operational/)).toBeInTheDocument();

    // The denominator is its own card, so the ratio stays legible rather than implied.
    const operational = screen.getByTestId('zone-kpi-operational');
    expect(within(operational).getByText('150')).toBeInTheDocument();
  });

  it('derives Inactive > 24Hr from the same buckets the table shows', async () => {
    renderAt('?zoneId=3&status=INACTIVE');
    const card = await screen.findByTestId('zone-kpi-critical-plus');
    // CRITICAL 25 + LONG_PENDING 15 — both at or above the CRITICAL band.
    expect(within(card).getByText('40')).toBeInTheDocument();
  });

  it('surfaces unassigned work and live batches from the zone-operations read', async () => {
    renderAt('?zoneId=3&status=INACTIVE');

    const unassigned = await screen.findByTestId('zone-kpi-unassigned');
    expect(within(unassigned).getByText('12')).toBeInTheDocument();
    expect(within(unassigned).getByText(/of 30 open tickets/)).toBeInTheDocument();

    const batches = screen.getByTestId('zone-kpi-batches');
    expect(within(batches).getByText('4')).toBeInTheDocument();
    expect(within(batches).getByText(/3 SEs engaged · 1 overridden/)).toBeInTheDocument();
  });

  it('swaps the headline pair to the healthy population under an ACTIVE filter', async () => {
    renderAt('?zoneId=3&status=ACTIVE');

    const healthy = await screen.findByTestId('zone-kpi-healthy');
    expect(within(healthy).getByText('110')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-kpi-inactive')).not.toBeInTheDocument();
  });
});

/** The Company/Plant Overview table only — the device table below also names companies. */
const overviewTable = () => screen.findByRole('table', { name: 'Company/Plant Overview' });

describe('Zone drill-down — zero rows are results, not absences', () => {
  it('keeps a plant with zero inactive devices, marked rather than dropped', async () => {
    renderAt('?zoneId=3&status=INACTIVE');
    const table = await overviewTable();

    // Both companies render, including the one with nothing in the filtered population.
    expect(within(table).getByText('UltraTech')).toBeInTheDocument();
    expect(within(table).getByText('Shree Cement')).toBeInTheDocument();
    // ...and it is flagged as empty-for-scope rather than removed, so an operator can tell a healthy
    // company from one missing from the data.
    const marked = within(table).getAllByTestId('company-row-empty-for-scope');
    expect(marked.length).toBe(1);
    expect(within(marked[0]).getByText('Shree Cement')).toBeInTheDocument();
  });

  it('sorts the zero row last while keeping it', async () => {
    renderAt('?zoneId=3&status=INACTIVE');
    const table = await overviewTable();

    const text = table.textContent ?? '';
    // The company carrying the inactivity comes first; the healthy one is still present, below it.
    expect(text.indexOf('UltraTech')).toBeLessThan(text.indexOf('Shree Cement'));
  });

  it('drops the SLA columns under ACTIVE, where every band is zero by definition', async () => {
    renderAt('?zoneId=3&status=ACTIVE');
    const table = await overviewTable();

    // A column that cannot carry information is removed; the rows themselves all remain.
    expect(within(table).queryByTestId('bucket-CRITICAL')).not.toBeInTheDocument();
    expect(within(table).getByText('Shree Cement')).toBeInTheDocument();
    expect(within(table).getByText('UltraTech')).toBeInTheDocument();
  });

  it('keeps the SLA columns under INACTIVE', async () => {
    renderAt('?zoneId=3&status=INACTIVE');
    const table = await overviewTable();
    expect(within(table).getAllByTestId('bucket-CRITICAL').length).toBeGreaterThan(0);
  });
});

describe('Zone drill-down — refused scopes', () => {
  it('renders an explanation instead of numbers for UNZONED', async () => {
    renderAt('?zoneId=UNZONED&status=INACTIVE');

    const note = await screen.findByTestId('zone-drilldown-unscoped');
    expect(note.textContent).toMatch(/different device populations/i);
    // Crucially: no aggregate is fetched, so no correct-looking total can be shown for a question
    // the operator did not ask.
    expect(overviewCalls()).toHaveLength(0);
    expect(zoneOpsCalls()).toHaveLength(0);
    expect(screen.queryByTestId('zone-kpi-inactive')).not.toBeInTheDocument();
  });

  it('renders an explanation instead of numbers when no zone is selected', async () => {
    renderAt('?status=INACTIVE');

    const note = await screen.findByTestId('zone-drilldown-unscoped');
    expect(note.textContent).toMatch(/Pick a single zone/i);
    expect(overviewCalls()).toHaveLength(0);
  });

  it('leaves the device table working in a refused scope', async () => {
    renderAt('?zoneId=UNZONED&status=INACTIVE');

    await screen.findByTestId('zone-drilldown-unscoped');
    // The table below is untouched by the section refusing to aggregate.
    expect(await screen.findByTestId('dev-row-900')).toBeInTheDocument();
    expect(requested.some((u) => u.includes('/devices?'))).toBe(true);
  });
});

describe('Zone drill-down — device table is not degraded', () => {
  it('loads the device list independently of the aggregates', async () => {
    renderAt('?zoneId=3&status=INACTIVE');

    // The device row renders whether or not the aggregate reads have resolved — they are separate
    // requests, neither gating the other.
    expect(await screen.findByTestId('dev-row-900')).toBeInTheDocument();
    expect(requested.some((u) => u.includes('/devices?'))).toBe(true);
  });
});
