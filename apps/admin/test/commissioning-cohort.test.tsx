import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommissioningCohortPage } from '../src/pages/reports/CommissioningCohortPage';

/**
 * #232 AC-1 — Commissioning Cohort page (ref `21-reports.png`).
 *
 * The assertions here are mostly about honesty rather than layout, because that is where this page can
 * do harm. It reports install quality, so a figure that overstates confidence — a median rendered as 0
 * when nothing was measured, a failure count that silently includes warehoused devices, a login shown
 * as if it were a named technician — is worse than a missing panel.
 */
const cohort = {
  cohortDays: 90,
  graceHours: 48,
  cohortStart: '2026-05-15T00:00:00.000Z',
  generatedAt: '2026-08-13T09:00:00.000Z',
  scopedToZoneId: null,
  filters: { zoneId: null, plantId: null, remarks: null, population: 'operational' },
  population: { fitmentsInWindow: 6810, operational: 2623, warehouse: 4187, deactivatedPlant: 0, unmirrored: 0 },
  resolution: {
    maturityHours: 72,
    maturedFitments: 2105,
    curveFitments: 65,
    sampleSize: 56,
    neverOnline: 9,
    preEpochExcluded: 2040,
    buckets: [
      { upToHours: 4, fitments: 2, cumulativeOnline: 2, cumulativeOnlinePct: 3.1 },
      { upToHours: 12, fitments: 9, cumulativeOnline: 11, cumulativeOnlinePct: 16.9 },
      { upToHours: 24, fitments: 31, cumulativeOnline: 42, cumulativeOnlinePct: 64.6 },
      { upToHours: 48, fitments: 12, cumulativeOnline: 54, cumulativeOnlinePct: 83.1 },
      { upToHours: 72, fitments: 0, cumulativeOnline: 54, cumulativeOnlinePct: 83.1 },
    ],
    beyondLastBucket: 2,
  },
  totals: {
    fitments: 2623,
    online: 2360,
    pending: 127,
    failed: 138,
    ttfr: { medianHours: 14.59, p95Hours: 29.1, sampleSize: 400 },
  },
  byPlant: [
    { plantId: '11', plantName: 'RCP-9211', zoneId: '1', fitments: 120, online: 118, pending: 1, failed: 1, ttfr: { medianHours: 12.5, p95Hours: 30, sampleSize: 40 } },
    { plantId: '12', plantName: 'DSTL K1PLANT', zoneId: '1', fitments: 30, online: 9, pending: 0, failed: 21, ttfr: { medianHours: null, p95Hours: null, sampleSize: 0 } },
  ],
  byInstaller: [
    { installerKey: 'RISDA_DURGESH', installerKind: 'UNCLASSIFIED', fitments: 80, online: 78, pending: 1, failed: 1, ttfr: { medianHours: 11, p95Hours: 20, sampleSize: 20 } },
    { installerKey: 'INTEGRATION_SERVICE', installerKind: 'SERVICE_ACCOUNT', fitments: 40, online: 20, pending: 0, failed: 20, ttfr: { medianHours: null, p95Hours: null, sampleSize: 0 } },
    { installerKey: null, installerKind: 'UNATTRIBUTED', fitments: 12, online: 6, pending: 0, failed: 6, ttfr: { medianHours: null, p95Hours: null, sampleSize: 0 } },
  ],
};

const installers = {
  lookbackDays: 90,
  since: '2026-05-15T00:00:00.000Z',
  generatedAt: '2026-08-13T09:00:00.000Z',
  groupBy: 'installer',
  scopedToZoneId: null,
  filters: { zoneId: null, plantId: null, remarks: null, minInstalls: 5, population: 'operational' },
  rows: [
    {
      installerKey: 'GB_BOKARO',
      installerKind: 'UNCLASSIFIED',
      installs: 46,
      neverOnline: 25,
      neverOnlineRate: 0.543,
      firstInstallAt: '2026-06-01T00:00:00.000Z',
      lastInstallAt: '2026-06-01T10:00:00.000Z',
      distinctPlants: 2,
      distinctInstallDays: 1,
      ttfr: { medianHours: null, p95Hours: null, sampleSize: 0 },
    },
  ],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/reports/commissioning/cohort')) return json(cohort);
    if (u.includes('/reports/commissioning/installers')) return json(installers);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Commissioning Cohort (#232 AC-1)', () => {
  it('renders the KPI strip from the endpoint', async () => {
    render(<CommissioningCohortPage />);
    expect(await screen.findByRole('heading', { name: /commissioning cohort/i })).toBeInTheDocument();

    expect(await screen.findByTestId('kpi-fitments')).toHaveTextContent('2623');
    expect(screen.getByTestId('kpi-online')).toHaveTextContent('2360');
    expect(screen.getByTestId('kpi-pending')).toHaveTextContent('127');
    expect(screen.getByTestId('kpi-failed')).toHaveTextContent('138');
  });

  it('carries a resolvable kpiCatalog entry on every KPI card (AC-3)', async () => {
    render(<CommissioningCohortPage />);
    await screen.findByTestId('kpi-fitments');
    // `KpiInfo` renders NOTHING for an unknown key, so a typo in the catalog key would silently drop
    // the provenance affordance and no other test would notice. This is the assertion that notices.
    for (const key of ['commissioningFitments', 'commissioningOnline', 'commissioningPending', 'commissioningFailed', 'commissioningTtfr']) {
      expect(screen.getByTestId(`kpi-info-${key}`)).toBeInTheDocument();
    }
  });

  it('shows the median with its sample size, because the sample is far smaller than the count beside it', async () => {
    render(<CommissioningCohortPage />);
    const ttfr = await screen.findByTestId('kpi-ttfr');
    expect(ttfr).toHaveTextContent('14.59 h');
    // 400 measurable against 2,360 online. A reader who cannot see that will over-trust the median.
    expect(ttfr).toHaveTextContent('n = 400');
  });

  it('renders a null median as "—", never as 0', async () => {
    render(<CommissioningCohortPage />);
    const table = await screen.findByRole('table', { name: /cohort by plant/i });
    // DSTL K1PLANT has 9 online but a null median: nothing about it was measurable. Zero would claim
    // those devices commissioned instantly, which is a different — and false — statement.
    expect(within(table).getByTestId('cc-plant-12')).toHaveTextContent('—');
  });

  it('names every drop between the window and the measure', async () => {
    render(<CommissioningCohortPage />);
    const census = await screen.findByTestId('commissioning-census');
    // Without this line a reader reconciling against AutoPlant concludes the page is broken. Before
    // #233 the page WOULD have been broken — those 4,187 were counted as failed installs.
    expect(census).toHaveTextContent('6810 fitments in window');
    expect(census).toHaveTextContent('2623 operational');
    expect(census).toHaveTextContent('4187 warehouse');
    expect(census).toHaveTextContent(/silent because they are in a warehouse/i);
  });

  it('defaults to the operational population and asks the server for it explicitly', async () => {
    render(<CommissioningCohortPage />);
    await screen.findByTestId('kpi-fitments');
    expect(urls().some((u) => u.includes('/reports/commissioning/cohort') && u.includes('population=operational'))).toBe(true);
  });

  it('re-queries when the population is switched to all', async () => {
    render(<CommissioningCohortPage />);
    await screen.findByTestId('kpi-fitments');
    await userEvent.selectOptions(screen.getByLabelText(/population/i), 'all');

    await waitFor(() => {
      expect(urls().some((u) => u.includes('/reports/commissioning/cohort') && u.includes('population=all'))).toBe(true);
    });
  });

  it('labels the widest window "last 90 days", not "3 months"', async () => {
    render(<CommissioningCohortPage />);
    const select = await screen.findByLabelText(/cohort window/i);
    // The server ceiling is 90 days and a 92-day request 400s. A label claiming three months would be
    // the page overstating its own scope by two days.
    expect(within(select).getByRole('option', { name: 'Last 90 days' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /3 months/i })).not.toBeInTheDocument();
  });

  it('states what the curve is measured over, including both exclusions', async () => {
    render(<CommissioningCohortPage />);
    const basis = await screen.findByTestId('commissioning-curve-basis');
    expect(basis).toHaveTextContent('65 fitments old enough to be graded');
    expect(basis).toHaveTextContent('56 measured');
    // Both exclusions are stated on the page, not just honoured in SQL — a curve over 65 of 2,623
    // fitments needs to say so.
    expect(basis).toHaveTextContent(/2040 pre-epoch fitments are excluded whatever they did/i);
    expect(basis).toHaveTextContent(/younger than 72 h/i);
  });

  it('labels every installer kind and refuses to present logins as people', async () => {
    render(<CommissioningCohortPage />);
    const table = await screen.findByRole('table', { name: /cohort by installer/i });

    expect(within(table).getByTestId('cc-installer-RISDA_DURGESH')).toHaveTextContent('Unresolved login');
    expect(within(table).getByTestId('cc-installer-INTEGRATION_SERVICE')).toHaveTextContent('Service account');
    expect(within(table).getByTestId('cc-installer-unattributed')).toHaveTextContent('No installer recorded');
    expect(screen.getByTestId('commissioning-installer-caveat')).toHaveTextContent(/never ranked as people/i);
  });

  it('renders the install-quality panel with the one-afternoon signature visible', async () => {
    render(<CommissioningCohortPage />);
    const row = await screen.findByTestId('iq-row-GB_BOKARO');
    expect(row).toHaveTextContent('54.3%');
    // 46 installs across 1 calendar day and 2 plants — a shape, and the reason this is a column.
    expect(row).toHaveTextContent('46');
    expect(row).toHaveTextContent('1');
  });

  it('tells a Zonal Manager their view is clamped', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/reports/commissioning/cohort')) return json({ ...cohort, scopedToZoneId: '1' });
      if (u.includes('/reports/commissioning/installers')) return json(installers);
      return json({});
    });
    render(<CommissioningCohortPage />);
    // Silently showing one zone's numbers under a page title that implies the fleet is exactly the
    // failure the backend's ZONE_SCOPE_VIOLATION exists to avoid.
    expect(await screen.findByTestId('commissioning-zone-clamp')).toHaveTextContent(/scoped to your zone/i);
  });

  it('explains an empty curve instead of drawing a flat zero line', async () => {
    const noCurve = {
      ...cohort,
      resolution: {
        ...cohort.resolution,
        curveFitments: 0,
        sampleSize: 0,
        neverOnline: 0,
        buckets: cohort.resolution.buckets.map((b) => ({ ...b, fitments: 0, cumulativeOnline: 0, cumulativeOnlinePct: null })),
      },
    };
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/reports/commissioning/cohort')) return json(noCurve);
      if (u.includes('/reports/commissioning/installers')) return json(installers);
      return json({});
    });
    render(<CommissioningCohortPage />);
    // A 0% curve says every device stayed dark. "Nothing was measured" is a different claim and has to
    // read differently.
    expect(await screen.findByText(/needs fitments older than the grace window/i)).toBeInTheDocument();
  });

  it('surfaces a load failure rather than rendering an empty page as if it were zero', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    render(<CommissioningCohortPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/failed to load the commissioning cohort/i);
  });
});
