import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNav } from '../src/components/shell/nav';
import { SeProductivityPage } from '../src/pages/reports/SeProductivityPage';

/**
 * #365 — SE Productivity, against the approved design
 * `docs/ui/desktop/approved-designs/se-productivity-report.html`.
 *
 * The three assertions that are not cosmetic:
 *
 *  - **Repair and Departure are separate columns** (audit F7). A page that showed only "Closures"
 *    would republish the mis-attribution the aggregation fix exists to remove.
 *  - **A withheld rate renders as a dash, never as a number and never as `0%`**, and the footer says
 *    the threshold. `0%` reads as a measured failure; the whole point is that nothing was measured.
 *  - **Nothing is ranked.** The rows arrive in the server's name order and stay in it, and no row is
 *    coloured as a whole — only individual out-of-band cells are marked.
 */
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  seId: 'se-1',
  name: 'Ramesh Kumar',
  coverageType: 'DEDICATED',
  zoneId: '1',
  zoneName: 'Rajasthan North',
  closures: 42,
  repairClosures: 31,
  departureClosures: 11,
  firstTimeFixes: 23,
  firstTimeFixRatePct: 74.2,
  verificationsDecided: 42,
  failedVerifications: 2,
  failedVerificationRatePct: 4.8,
  onsiteToSubmissionCount: 20,
  avgOnsiteToSubmissionSeconds: 4320, // 1h 12m
  ratesSuppressed: false,
  ...over,
});

/** The design's four engineers: two healthy, one flagged on every metric, one below the floor. */
const report = {
  granularity: 'monthly',
  from: '2026-06-01',
  to: '2026-06-30',
  rateMinSample: 10,
  dataAsOf: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  filters: { zoneId: 1, coverage: 'all' },
  totals: { engineers: 4, closures: 107, repairClosures: 76, departureClosures: 31 },
  rows: [
    row(),
    row({ seId: 'se-2', name: 'Suresh Patel', closures: 38, repairClosures: 29, departureClosures: 9, firstTimeFixRatePct: 76.3, failedVerificationRatePct: 2.6, avgOnsiteToSubmissionSeconds: 3480 }),
    row({
      seId: 'se-3', name: 'Anil Singh', coverageType: 'FLOATING',
      closures: 21, repairClosures: 12, departureClosures: 9,
      firstTimeFixRatePct: 57.1, failedVerificationRatePct: 14.3, avgOnsiteToSubmissionSeconds: 7500,
    }),
    row({
      seId: 'se-4', name: 'Manoj Rao', coverageType: 'FLOATING',
      closures: 6, repairClosures: 4, departureClosures: 2,
      firstTimeFixes: 3, firstTimeFixRatePct: null,
      verificationsDecided: 4, failedVerifications: 0, failedVerificationRatePct: null,
      avgOnsiteToSubmissionSeconds: 5400, ratesSuppressed: true,
    }),
  ],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
  fetchMock.mockImplementation(async (url: string) =>
    String(url).includes('/reports/se-productivity') ? json(report) : json({ zones: [{ zoneId: 1, name: 'Rajasthan North' }], companies: [], plants: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

const at = (path = '/reports/se-productivity') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SeProductivityPage />
    </MemoryRouter>,
  );

const seProductivityCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/reports/se-productivity'));

describe('SE Productivity (#365)', () => {
  it('renders one row per engineer with the closure split the design requires', async () => {
    at();
    expect(await screen.findByRole('heading', { name: /se productivity/i })).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: /se productivity/i });
    const header = within(table).getAllByRole('row')[0];
    // F7 — Repair and Departure are their own columns, not one "Closures" number.
    expect(header).toHaveTextContent(/Repair/);
    expect(header).toHaveTextContent(/Departure/);

    const ramesh = await screen.findByTestId('se-prod-row-se-1');
    expect(ramesh).toHaveTextContent('Ramesh Kumar');
    expect(ramesh).toHaveTextContent('Dedicated');
    expect(ramesh).toHaveTextContent('42');
    expect(ramesh).toHaveTextContent('31');
    expect(ramesh).toHaveTextContent('11');
    expect(ramesh).toHaveTextContent('74.2%');
    expect(ramesh).toHaveTextContent('4.8%');
    expect(ramesh).toHaveTextContent('1h 12m');
  });

  /** The operator constraint: below the floor a rate is a dash with a reason, never a number. */
  it('dashes the withheld rates of a below-threshold engineer and keeps every count', async () => {
    at();
    const manoj = await screen.findByTestId('se-prod-row-se-4');
    // Counts are facts about six jobs and are shown.
    expect(manoj).toHaveTextContent('6');
    expect(manoj).toHaveTextContent('4');
    expect(manoj).toHaveTextContent('2');
    // Rates are not.
    expect(manoj).not.toHaveTextContent('%');
    const withheld = within(manoj).getAllByText('—');
    expect(withheld).toHaveLength(2);
    for (const cell of withheld) expect(cell).toHaveAttribute('data-withheld', 'small-sample');
    // The average stage time is NOT a rate and is not suppressed with them.
    expect(manoj).toHaveTextContent('1h 30m');
  });

  it('states the window, the totals and the suppression threshold in the footer', async () => {
    at();
    const footer = await screen.findByTestId('se-productivity-footer');
    expect(footer).toHaveTextContent('4 engineers · 107 closures in window');
    expect(footer).toHaveTextContent(/31 closed by device departure, not repair/);
    expect(footer).toHaveTextContent(/Rates suppressed below 10 closures/i);
    expect(await screen.findByTestId('se-productivity-window')).toHaveTextContent('2026-06-01 → 2026-06-30');
  });

  /**
   * Diagnostic surface, not a league table. The order is the server's (by name); the flagged engineer
   * is third, not first, and the marking is on individual cells rather than on the row.
   */
  it('does not rank: server order is kept and only out-of-band cells are marked', async () => {
    at();
    await screen.findByTestId('se-prod-row-se-1');
    const table = screen.getByRole('table', { name: /se productivity/i });
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'se-prod-row-se-1',
      'se-prod-row-se-2',
      'se-prod-row-se-3',
      'se-prod-row-se-4',
    ]);

    const anil = screen.getByTestId('se-prod-row-se-3');
    // 57.1% first-time fix (below 65) and 2h 05m (above 1h 40m) are amber; 14.3% failed (above 12) is
    // crimson. The row itself carries no tone — only the three cells do.
    expect(within(anil).getByText('57.1%')).toHaveAttribute('data-tone', 'warn');
    expect(within(anil).getByText('14.3%')).toHaveAttribute('data-tone', 'bad');
    expect(within(anil).getByText('2h 05m')).toHaveAttribute('data-tone', 'warn');
    expect(anil).not.toHaveAttribute('data-tone');

    // A healthy engineer is not badged as "best" — every one of their cells is plain.
    const suresh = screen.getByTestId('se-prod-row-se-2');
    expect(within(suresh).getByText('76.3%')).toHaveAttribute('data-tone', 'normal');
    expect(within(suresh).getByText('2.6%')).toHaveAttribute('data-tone', 'normal');
  });

  /** #347's band, on this page too — the stamp is the report's, never the browser clock. */
  it('carries the freshness stamp and the server-echoed scope chip', async () => {
    at();
    const stamp = await screen.findByTestId('se-productivity-data-as-of');
    expect(stamp).toHaveAttribute('data-freshness', 'fresh');
    const scope = await screen.findByTestId('se-productivity-scope');
    await waitFor(() => expect(scope).toHaveTextContent(/rajasthan north/i));
  });

  /**
   * #364's rule — the chip renders the ANSWER, not the question. A ZM who picks zone 2 is clamped to
   * zone 1 server-side, and the chip must say so rather than label zone 2 over zone 1's numbers.
   */
  it('flags the clamp when the server echoes a different zone than the one picked', async () => {
    at('/reports/se-productivity?zoneId=2');
    const scope = await screen.findByTestId('se-productivity-scope');
    await waitFor(() => expect(scope).toHaveAttribute('data-clamped', 'true'));
    expect(scope).toHaveTextContent(/scoped to your zone/i);
  });

  describe('the filter controls', () => {
    it('sends the month and zone the URL carries', async () => {
      at('/reports/se-productivity?month=2026-06&zoneId=1');
      await screen.findByTestId('se-prod-row-se-1');
      const url = seProductivityCalls().at(-1)!;
      expect(url).toContain('month=2026-06');
      expect(url).toContain('zoneId=1');
      expect(url).toContain('granularity=monthly');
    });

    it('switches to a weekly window and sends the week anchor', async () => {
      at('/reports/se-productivity?granularity=weekly&weekOf=2026-06-17');
      await screen.findByTestId('se-prod-row-se-1');
      const url = seProductivityCalls().at(-1)!;
      expect(url).toContain('granularity=weekly');
      expect(url).toContain('weekOf=2026-06-17');
      // The month control belongs to the monthly mode only; a week picker replaces it.
      expect(screen.getByLabelText('Week of')).toBeInTheDocument();
      expect(screen.queryByLabelText('Month')).not.toBeInTheDocument();
    });

    it('sends the coverage filter when one is picked', async () => {
      at();
      await screen.findByTestId('se-prod-row-se-1');
      await userEvent.selectOptions(screen.getByLabelText('Coverage'), 'FLOATING');
      await waitFor(() => expect(seProductivityCalls().at(-1)).toContain('coverage=FLOATING'));
    });

    /** `all` is the default and is not a filter — it must not appear in the query string. */
    it('omits the coverage parameter when it is "all"', async () => {
      at();
      await screen.findByTestId('se-prod-row-se-1');
      expect(seProductivityCalls().at(-1)).not.toContain('coverage=');
    });
  });
});

describe('SE Productivity nav (#365)', () => {
  it('is in the Analytics group for every manager role and absent for the others', () => {
    for (const role of ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']) {
      const analytics = buildNav(role).find((g) => g.heading === 'Analytics');
      expect(analytics?.items.map((i) => i.to)).toContain('/reports/se-productivity');
    }
    for (const role of ['WAREHOUSE_MANAGER', 'SERVICE_ENGINEER']) {
      const links = buildNav(role).flatMap((g) => g.items.map((i) => i.to));
      expect(links).not.toContain('/reports/se-productivity');
    }
  });
});
